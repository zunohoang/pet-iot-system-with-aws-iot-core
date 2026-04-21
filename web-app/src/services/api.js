// HTTPS requests to API Gateway (Backend Lambda)
const API_BASE = process.env.REACT_APP_API_URL;

export const getDevices = () => fetch(`${API_BASE}/devices`).then(r => r.json());
export const sendCommand = (deviceId, cmd) =>
  fetch(`${API_BASE}/devices/${deviceId}/command`, {
    method: 'POST',
    body: JSON.stringify(cmd),
  }).then(r => r.json());
