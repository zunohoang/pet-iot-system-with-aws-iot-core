import Constants from 'expo-constants';
import { getTokens } from './auth';

const API_BASE = Constants.expoConfig.extra.API_BASE_URL;

async function authHeaders() {
  const tokens = await getTokens();
  if (!tokens?.idToken) throw new Error('Not authenticated');
  return {
    'Content-Type':  'application/json',
    Authorization:   tokens.idToken,
  };
}

async function request(method, path, body) {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── Devices ──────────────────────────────────────────────────────────── */
export const listDevices        = ()                   => request('GET', '/devices');
export const getDevice          = (id)                 => request('GET', `/devices/${id}`);
export const updateDeviceShadow = (id, state)          => request('POST', `/devices/${id}/shadow`, state);
export const getTelemetry       = (id, minutes = 60)   => request('GET', `/devices/${id}/telemetry?minutes=${minutes}`);
export const registerClaim      = (serialNumber, type) => request('POST', '/devices/claim', { serialNumber, deviceType: type });

/* ── Scenes ───────────────────────────────────────────────────────────── */
export const listScenes   = ()                => request('GET',    '/scenes');
export const createScene  = (scene)           => request('POST',   '/scenes', scene);
export const updateScene  = (id, scene)       => request('PUT',    `/scenes/${id}`, scene);
export const deleteScene  = (id)              => request('DELETE', `/scenes/${id}`);
export const runScene     = (id)              => request('POST',   `/scenes/${id}/run`);

/* ── OTA ──────────────────────────────────────────────────────────────── */
export const deployOta    = (version, deviceType, deviceIds) =>
  request('POST', '/ota/deploy', { version, deviceType, deviceIds });
export const listOtaJobs  = () => request('GET', '/ota/jobs');
