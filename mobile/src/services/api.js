import Constants from 'expo-constants';
import { Buffer } from 'buffer';
import { getTokens } from './auth';

const extra =
  Constants.expoConfig?.extra ||
  Constants.manifest?.extra ||
  Constants.manifest2?.extra ||
  {};
const API_BASE = extra.API_BASE_URL;

function getTokenSub(idToken) {
  try {
    const payloadB64 = idToken.split('.')[1];
    if (!payloadB64) return null;
    const normalized = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return payload?.sub || null;
  } catch {
    return null;
  }
}

async function authHeaders() {
  const tokens = await getTokens();
  if (!tokens?.idToken) throw new Error('Not authenticated');
  const tokenSub = getTokenSub(tokens.idToken);
  console.log('[api] auth headers', {
    apiBase: API_BASE,
    userIdFromStore: tokens.userId || null,
    tokenSub,
    sameUser: tokenSub ? tokenSub === tokens.userId : null,
  });
  return {
    'Content-Type':  'application/json',
    Authorization:   tokens.idToken,
  };
}

async function request(method, path, body) {
  if (!API_BASE) throw new Error('API_BASE_URL is not configured');
  const headers = await authHeaders();
  const url = `${API_BASE}${path}`;
  const startedAt = Date.now();
  console.log('[api] request', { method, url, hasBody: Boolean(body) });
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  console.log('[api] response', {
    method,
    url,
    status: res.status,
    elapsedMs: Date.now() - startedAt,
    body: data ?? text,
  });
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── Devices ──────────────────────────────────────────────────────────── */
export const listDevices        = ()                   => request('GET', '/devices');
export const getDevice          = (id)                 => request('GET', `/devices/${id}`);
export const updateDeviceShadow = (id, state)          => request('POST', `/devices/${id}/shadow`, state);
export const getTelemetry       = (id, minutes = 60)   => request('GET', `/devices/${id}/telemetry?minutes=${minutes}`);
export const registerClaim = (claimId) => request('POST', '/devices/claim', { claimId });
export const claimDevice   = (claimId) => request('POST', '/devices/claim', { claimId });
function makeTempClaimId(deviceType = 'switch') {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${(deviceType || 'switch').toUpperCase()}-${Date.now()}-${suffix}`;
}

export const createAutoClaim = async (deviceType) => {
  try {
    return await request('POST', '/devices/claim/auto', { deviceType });
  } catch (e) {
    const message = e?.message || '';
    const missingAutoRoute =
      message.includes('Route not found') ||
      message.includes('HTTP 404');
    if (!missingAutoRoute) throw e;

    // Backward-compatible fallback for older backend deployments.
    const claimId = makeTempClaimId(deviceType);
    await request('POST', '/admin/claims', { claimId, deviceType: deviceType || 'switch' });
    await request('POST', '/devices/claim', { claimId });
    return { claimId, deviceType: deviceType || 'switch', fallback: true };
  }
};
/** Short-lived X.509 from CreateProvisioningClaim (Trusted User). */
export const createProvisioningClaim = (claimId) =>
  request('POST', '/devices/provisioning-claim', { claimId });

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
