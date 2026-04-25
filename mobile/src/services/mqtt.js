/**
 * MQTT Service — AWS IoT Core via AWS Amplify PubSub (v6).
 *
 * Replaces the previous mqtt.js WebSocket / SigV4 manual approach
 * which did not work reliably in Expo / React Native.
 *
 * Amplify PubSub handles internally:
 *  - Cognito Identity Pool → STS temporary credentials
 *  - SigV4 WebSocket URL signing
 *  - MQTT over WebSocket to IoT Core (port 443)
 *
 * Public API is **identical** to the previous service — no screen changes needed.
 *
 * Usage note:
 *   The MQTT WebSocket is established lazily on the FIRST subscribe() call.
 *   publish() before any subscribe() will fail silently; call connect() first.
 */

import { PubSub, CONNECTION_STATE_CHANGE, ConnectionState } from '@aws-amplify/pubsub';
import { Hub } from 'aws-amplify/utils';
import Constants from 'expo-constants';
import { fetchIoTCredentials } from './amplifyConfig';

const {
  AWS_REGION,
  IOT_ENDPOINT,
} = Constants.expoConfig.extra;

/* ── Singleton PubSub client ───────────────────────────────────────── */

const pubsub = new PubSub({
  region: AWS_REGION,
  endpoint: `wss://${IOT_ENDPOINT}/mqtt`,
  clientId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
});

console.log('[MQTT] PubSub client created', { region: AWS_REGION, endpoint: IOT_ENDPOINT, clientId: pubsub.clientId });

/* ── State ─────────────────────────────────────────────────────────── */

/** topic (string) → Map<callback (fn), RxSubscription> */
const subscribers = new Map();
const statusListeners = new Set();
let _connected = false;
let _hubUnsubscribe = null;
let _warmupSub = null;

/* ── Connection status ─────────────────────────────────────────────── */

function setConnected(value) {
  if (_connected === value) return;
  _connected = value;
  console.log('[MQTT] connection status ->', value);
  statusListeners.forEach((listener) => {
    try { listener(value); } catch (e) { console.warn('[MQTT] status listener error', e); }
  });
}

function startHubListener() {
  if (_hubUnsubscribe) return;
  _hubUnsubscribe = Hub.listen('pubsub', ({ payload }) => {
    const { event, data } = payload;
    if (event === CONNECTION_STATE_CHANGE) {
      const state = data?.connectionState;
      console.log('[MQTT] Hub →', state);
      const connected =
        state === ConnectionState.Connected ||
        state === ConnectionState.ConnectedPendingNetwork;
      setConnected(connected);
    }
  });
  console.log('[MQTT] Hub listener started');
}

function stopHubListener() {
  if (_hubUnsubscribe) {
    _hubUnsubscribe();
    _hubUnsubscribe = null;
    console.log('[MQTT] Hub listener stopped');
  }
}

/* ── Internal message dispatcher ──────────────────────────────────── */

function dispatchMessage(receivedTopic, rawValue) {
  let data;
  try {
    data = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  } catch {
    data = rawValue;
  }

  subscribers.forEach((cbMap, pattern) => {
    if (topicMatches(pattern, receivedTopic)) {
      cbMap.forEach((_, cb) => {
        try { cb(receivedTopic, data); } catch (e) {
          console.warn('[MQTT] subscriber callback error', e);
        }
      });
    }
  });
}

/* ── Public API ────────────────────────────────────────────────────── */

/**
 * Warm up the MQTT connection.
 * Amplify PubSub connects lazily on first subscribe(), so we trigger
 * a dummy subscribe to open the WebSocket early and report connection status.
 */
export function connect(clientId) {
  console.log('[MQTT] connect() called', { clientId });
  startHubListener();

  // Pre-warm credential cache so AWSIoT.endpoint() doesn't stall on first subscribe
  fetchIoTCredentials().catch(err =>
    console.error('[MQTT] credential pre-warm failed:', err?.message),
  );

  return new Promise((resolve, reject) => {
    if (_connected) {
      resolve(pubsub);
      return;
    }

    const TIMEOUT_MS = 20000;

    let settled = false;
    let timeoutId = null;
    let hubUnsub = null;

    function finish(connected, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (hubUnsub) { hubUnsub(); hubUnsub = null; }
      
      // DO NOT unsubscribe _warmupSub here!
      // If we unsubscribe before the rest of the app subscribes, Amplify will immediately
      // drop the connection (ConnectedPendingDisconnect).

      if (connected) {
        resolve(pubsub);
      } else {
        reject(err || new Error('[MQTT] connection failed'));
      }
    }

    // Listen for connection state changes specifically for this connect() call
    hubUnsub = Hub.listen('pubsub', ({ payload }) => {
      const { event, data } = payload;
      if (event === CONNECTION_STATE_CHANGE) {
        const state = data?.connectionState;
        if (
          state === ConnectionState.Connected ||
          state === ConnectionState.ConnectedPendingNetwork
        ) {
          finish(true);
        } else if (
          state === ConnectionState.ConnectionDisrupted ||
          state === ConnectionState.ConnectionDisruptedPendingNetwork
        ) {
          // Don't reject — Hub will fire Connected shortly after a disruption
          console.warn('[MQTT] connection disrupted, waiting...');
        }
      }
    });

    timeoutId = setTimeout(() => {
      finish(false, new Error('[MQTT] Connection timeout after 20s'));
    }, TIMEOUT_MS);

    // Trigger the WebSocket connection by subscribing to a harmless topic
    // that exactly matches the allowed IAM policy (e.g., devices/+/status)
    try {
      _warmupSub = pubsub
        .subscribe({ topics: ['devices/+/status'] })
        .subscribe({
          next: () => {},
          error: (err) => {
            console.error('[MQTT] warmup subscribe error:', err?.message || err);
            // Don't reject immediately — might still connect
          },
          complete: () => {},
        });
    } catch (err) {
      // Thrown synchronously on bad config
      finish(false, new Error(`[MQTT] PubSub init error: ${err?.message || err}`));
    }
  });
}

/** Subscribe to an MQTT topic pattern (supports + and # wildcards). */
export function subscribe(topic, callback) {
  if (!subscribers.has(topic)) {
    subscribers.set(topic, new Map());
  }
  const cbMap = subscribers.get(topic);

  if (cbMap.has(callback)) {
    // Already registered
    return () => unsubscribe(topic, callback);
  }

  console.log('[MQTT] subscribing to', topic);

  const rxSub = pubsub
    .subscribe({ topics: [topic] })
    .subscribe({
      next: (msg) => {
        console.log('[MQTT] raw message on', topic, ':', msg);
        dispatchMessage(topic, msg);
      },
      error: (err) => {
        console.error('[MQTT] subscription error on', topic, err?.message || err);
        setConnected(false);
      },
      complete: () => {
        console.log('[MQTT] subscription complete for', topic);
      },
    });

  cbMap.set(callback, rxSub);
  return () => unsubscribe(topic, callback);
}

/** Unsubscribe a specific callback from a topic. */
export function unsubscribe(topic, callback) {
  const cbMap = subscribers.get(topic);
  if (!cbMap) return;

  const rxSub = cbMap.get(callback);
  if (rxSub) {
    try { rxSub.unsubscribe(); } catch (_) { /* ignore */ }
    cbMap.delete(callback);
  }

  if (cbMap.size === 0) {
    subscribers.delete(topic);
    console.log('[MQTT] fully unsubscribed from', topic);
  }
}

/** Publish a message to a topic. */
export async function publish(topic, payload) {
  try {
    let message = payload;
    if (typeof payload === 'string') {
      try { message = JSON.parse(payload); } catch (_) { message = payload; }
    }
    await pubsub.publish({
      topics: [topic],
      message,
    });
    console.log('[MQTT] published to', topic);
  } catch (err) {
    console.error('[MQTT] publish error:', err?.message || err);
  }
}

/** Disconnect — clean up all subscriptions. */
export function disconnect() {
  console.log('[MQTT] disconnect called');
  subscribers.forEach((cbMap) => {
    cbMap.forEach((rxSub) => { try { rxSub?.unsubscribe?.(); } catch (_) { /* ignore */ } });
  });
  subscribers.clear();
  if (_warmupSub) {
    try { _warmupSub.unsubscribe(); } catch (_) {}
    _warmupSub = null;
  }
  stopHubListener();
  setConnected(false);
}

export function isConnected() {
  return _connected;
}

export function onConnectionStatusChange(listener) {
  statusListeners.add(listener);
  listener(_connected);
  return () => statusListeners.delete(listener);
}

/* ── MQTT wildcard matching ─────────────────────────────────────────── */
function topicMatches(pattern, topic) {
  if (pattern === topic) return true;
  if (pattern.endsWith('#')) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  const patParts = pattern.split('/');
  const topParts = topic.split('/');
  if (patParts.length !== topParts.length) return false;
  return patParts.every((p, i) => p === '+' || p === topParts[i]);
}
