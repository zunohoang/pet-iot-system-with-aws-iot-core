/**
 * MQTT Service — connects to AWS IoT Core via WebSocket (port 443)
 *
 * Authentication flow:
 * 1. Get Cognito Identity Pool credentials (temporary AWS STS creds)
 * 2. Sign the WebSocket URL using AWS Signature V4
 * 3. Connect via mqtt.js using the signed URL as the broker
 *
 * This allows each authenticated app user to connect to IoT Core
 * with scoped IAM permissions (defined in Cognito Identity Pool role).
 */

import mqtt from 'mqtt';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import Constants from 'expo-constants';
import { getTokens } from './auth';

const {
  AWS_REGION,
  COGNITO_USER_POOL_ID,
  COGNITO_IDENTITY_POOL_ID,
  IOT_ENDPOINT,
} = Constants.expoConfig.extra;

let mqttClient = null;
const subscribers = new Map();   /* topic → Set<callback> */

/* ── SigV4 WebSocket URL Signer ──────────────────────────────────────── */

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSHA256(key, data) {
  const encoder = new TextEncoder();
  const keyData  = typeof key === 'string' ? encoder.encode(key) : key;
  const dataEnc  = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, dataEnc));
}

async function sha256Hex(data) {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return toHex(hash);
}

async function signIoTWebSocketUrl(credentials) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const service = 'iotdevicegateway';
  const host    = IOT_ENDPOINT;

  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dateShort = dateStr.substring(0, 8);

  const scope = `${dateShort}/${AWS_REGION}/${service}/aws4_request`;

  const canonicalQueryString = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${encodeURIComponent(`${accessKeyId}/${scope}`)}`,
    `X-Amz-Date=${dateStr}`,
    `X-Amz-SignedHeaders=host`,
    sessionToken ? `X-Amz-Security-Token=${encodeURIComponent(sessionToken)}` : '',
  ].filter(Boolean).join('&');

  const canonicalRequest = [
    'GET',
    '/mqtt',
    canonicalQueryString,
    `host:${host}\n`,
    'host',
    await sha256Hex(''),
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStr,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await (async () => {
    const k1 = await hmacSHA256(`AWS4${secretAccessKey}`, dateShort);
    const k2 = await hmacSHA256(k1, AWS_REGION);
    const k3 = await hmacSHA256(k2, service);
    return hmacSHA256(k3, 'aws4_request');
  })();

  const signature = toHex(await hmacSHA256(signingKey, stringToSign));

  const signedUrl =
    `wss://${host}/mqtt?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return signedUrl;
}

/* ── Cognito Identity credentials ────────────────────────────────────── */

async function getAWSCredentials() {
  const tokens = await getTokens();
  if (!tokens?.idToken) throw new Error('Not signed in');

  const identityClient = new CognitoIdentityClient({ region: AWS_REGION });

  const idResult = await identityClient.send(new GetIdCommand({
    IdentityPoolId: COGNITO_IDENTITY_POOL_ID,
    Logins: {
      [`cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`]: tokens.idToken,
    },
  }));

  const credsResult = await identityClient.send(new GetCredentialsForIdentityCommand({
    IdentityId: idResult.IdentityId,
    Logins: {
      [`cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`]: tokens.idToken,
    },
  }));

  return {
    accessKeyId:     credsResult.Credentials.AccessKeyId,
    secretAccessKey: credsResult.Credentials.SecretKey,
    sessionToken:    credsResult.Credentials.SessionToken,
  };
}

/* ── Public API ─────────────────────────────────────────────────────── */

/**
 * Connect to AWS IoT Core via MQTT over WebSocket.
 * Resolves when the connection is established.
 */
export async function connect(clientId) {
  if (mqttClient?.connected) return mqttClient;

  const credentials = await getAWSCredentials();
  const signedUrl   = await signIoTWebSocketUrl(credentials);

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(signedUrl, {
      clientId:         clientId || `mobile-${Date.now()}`,
      protocol:         'wss',
      reconnectPeriod:  5000,
      connectTimeout:   10000,
      clean:            true,
    });

    client.on('connect', () => {
      console.log('[MQTT] Connected to AWS IoT Core');
      mqttClient = client;
      resolve(client);
    });

    client.on('error', (err) => {
      console.error('[MQTT] Error:', err);
      reject(err);
    });

    client.on('reconnect', () => {
      console.log('[MQTT] Reconnecting...');
    });

    client.on('message', (topic, payload) => {
      let data;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        data = payload.toString();
      }

      /* Dispatch to all matching subscribers */
      subscribers.forEach((callbacks, pattern) => {
        if (topicMatches(pattern, topic)) {
          callbacks.forEach(cb => cb(topic, data));
        }
      });
    });
  });
}

/** Subscribe to an MQTT topic pattern (supports + and # wildcards). */
export function subscribe(topic, callback) {
  if (!mqttClient?.connected) {
    console.warn('[MQTT] Not connected — cannot subscribe to', topic);
    return;
  }

  if (!subscribers.has(topic)) {
    subscribers.set(topic, new Set());
    mqttClient.subscribe(topic, { qos: 1 });
  }
  subscribers.get(topic).add(callback);

  return () => unsubscribe(topic, callback);
}

/** Unsubscribe a specific callback from a topic. */
export function unsubscribe(topic, callback) {
  const set = subscribers.get(topic);
  if (!set) return;
  set.delete(callback);
  if (set.size === 0) {
    subscribers.delete(topic);
    mqttClient?.unsubscribe(topic);
  }
}

/** Publish a message to a topic. */
export function publish(topic, payload) {
  if (!mqttClient?.connected) {
    console.warn('[MQTT] Not connected — cannot publish to', topic);
    return;
  }
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  mqttClient.publish(topic, body, { qos: 1 });
}

/** Disconnect from the broker. */
export function disconnect() {
  mqttClient?.end(true);
  mqttClient = null;
  subscribers.clear();
}

export function isConnected() {
  return mqttClient?.connected === true;
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
