# IoT Smart Home System

AWS-based IoT system with two ESP32 devices (Light Switch + DHT11 Sensor),
React Native Expo mobile app, and full infrastructure as Terraform.

## Architecture

```
DEVICE LAYER
├── ESP32-A  Light Switch (Relay GPIO26)   → device/switch/
└── ESP32-B  DHT11 Sensor (GPIO4)          → device/sensor/

AWS IoT CORE
├── MQTT Broker (TLS 8883 / WebSocket 443)
├── Device Shadow Service
├── Fleet Provisioning (Trusted User — short-lived claim cert from API)
├── Rules Engine  → Timestream, Lambda, DynamoDB
└── IoT Jobs (OTA)

PROCESSING (Lambda + API Gateway)
├── api              – REST API (devices, scenes, OTA)
├── iot-processor    – Timestream write + SNS alerts
├── scene-engine     – Smart automation execution
├── ota-manager      – S3 presigned URL + IoT Jobs
└── provisioning-hook – Fleet Provisioning validation

DATA
├── DynamoDB  (devices, scenes, ota-jobs, device-claims)
└── Timestream (telemetry time-series, 1-year retention)

AUTH
└── Cognito User Pool + Identity Pool (IoT WebSocket SigV4)

MOBILE APP → mobile/  (React Native Expo)
```

**Environment (examples only in git; real secrets in gitignored `terraform.tfvars` / `.env`):**

| Path | Purpose |
|------|---------|
| [`.env.example`](.env.example) | Monorepo pointer |
| [`infra/terraform.tfvars.example`](infra/terraform.tfvars.example) | `terraform apply` |
| [`mobile/.env.example`](mobile/.env.example) | Expo (`cp` → `.env`) |
| [`backend/.env.example`](backend/.env.example) | Local Lambda / tests |
| [`device/switch/.env.example`](device/switch/.env.example), [`device/sensor/...`](device/sensor/.env.example) | Checklist → `config.h` |

## Project Structure

```
p_iows/
├── device/
│   ├── switch/src/      ESP32 Light Switch firmware (ESP-IDF C)
│   └── sensor/src/      ESP32 DHT11 Sensor firmware (ESP-IDF C)
├── backend/
│   └── functions/
│       ├── api/                  REST API handler
│       ├── iot-processor/        Telemetry processor
│       ├── scene-engine/         Automation engine
│       ├── ota-manager/          OTA job creator
│       └── provisioning-hook/    Fleet provisioning validator
├── mobile/              React Native Expo app
│   └── src/
│       ├── screens/     Dashboard, DeviceControl, Monitoring, Scenes
│       ├── services/    auth.js, api.js, mqtt.js
│       └── hooks/       useDeviceShadow.js, useTelemetry.js
└── infra/               Terraform modules
    └── modules/
        ├── auth/        Cognito User Pool + Identity Pool
        ├── iot/         IoT Policies + Rules Engine
        ├── provisioning/ Fleet Provisioning templates + pre-provision hook
        ├── processing/  Lambda + API Gateway
        ├── data/        DynamoDB + Timestream
        ├── notification/ SNS
        └── ota/         S3 Firmware Storage
```

## Quick Start

### 1. Deploy Infrastructure

```bash
cd infra
terraform init
terraform apply -var="alert_email=your@email.com"
```

After apply, extract outputs:
```bash
terraform output api_gateway_url
terraform output cognito_user_pool_id
terraform output cognito_client_id
terraform output cognito_identity_pool_id
terraform output iot_data_endpoint
```

Download the public Amazon Root CA into each firmware `main/` component (required for TLS to IoT Core):

```bash
curl -o device/switch/main/root_ca.pem \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem
cp device/switch/main/root_ca.pem device/sensor/main/root_ca.pem
```

Factory **claim** PEM/key are **not** produced by Terraform anymore. The app calls `POST /devices/provisioning-claim` (backend uses `iot:CreateProvisioningClaim`) and the device stores the short-lived cert in NVS before running `provisioning_run()`.

### 2. Flash Device Firmware

**Light Switch (ESP32-A):**
```bash
cd device/switch
# Edit src/config.h: WIFI_SSID, WIFI_PASSWORD, AWS_IOT_ENDPOINT (fallback if iot_host not in NVS)
idf.py set-target esp32
idf.py build flash monitor
```

**DHT11 Sensor (ESP32-B):**
```bash
cd device/sensor
# Edit src/config.h: same as switch
idf.py set-target esp32
idf.py build flash monitor
```

**Trusted User provisioning (summary):** Admin pre-registers the serial (`POST /admin/claims`). The user links the device in the app (`POST /devices/claim`), then requests a provisioning bundle (`POST /devices/provisioning-claim`). While the cert is valid (~5 minutes), transfer WiFi + cert + private key + `iotDataEndpoint` to the firmware (BLE or your transport) and call `provisioning_set_trusted_user_credentials()` before the first `provisioning_run()`. After success, permanent device certs live in NVS.

### 3. Configure mobile app (env)

```bash
cd mobile
cp .env.example .env
# Fill EXPO_PUBLIC_* from terraform output (including iot_data_endpoint)
npm install
npx expo start
```

`mobile/app.config.js` merges `extra` with `.env` (`EXPO_PUBLIC_*`). Mobile realtime MQTT uses SigV4-signed `wss://<iot_data_endpoint>/mqtt` on port 443.

### 4. Pre-register a device (admin)

Before shipping, register the serial and device type:
```bash
curl -X POST <API_URL>/admin/claims \
  -H "Authorization: <Cognito ID Token>" \
  -H "Content-Type: application/json" \
  -d '{"serialNumber":"AABBCCDDEEFF","deviceType":"switch"}'
```

End users link the device in the app (or `POST /devices/claim`), then use **Add device** in the app to obtain a short-lived provisioning bundle.

### 5. Deploy OTA Update

```bash
# Upload firmware binary to S3
aws s3 cp firmware.bin \
  s3://iot-smarthome-firmware-storage/firmware/switch/v1.1.0/firmware.bin

# Trigger OTA via API
curl -X POST <API_URL>/ota/deploy \
  -H "Authorization: <token>" \
  -d '{"version":"1.1.0","deviceType":"switch"}'
```

## MQTT Topics

| Topic | Publisher | Purpose |
|---|---|---|
| `devices/{id}/telemetry` | Sensor | Temperature + humidity data |
| `devices/{id}/status` | Any device | Online state + relay status |
| `$aws/things/{id}/shadow/get` | Mobile (WSS) | Request current shadow snapshot |
| `$aws/things/{id}/shadow/get/accepted|rejected` | IoT Core | Shadow get response |
| `$aws/things/{id}/shadow/update` | Device / Backend | Desired/reported state update |
| `$aws/things/{id}/shadow/update/accepted|rejected` | IoT Core | Shadow update response |
| `$aws/things/{id}/shadow/update/delta` | IoT Core | State diff notification |
| `$aws/things/{id}/jobs/notify` | IoT Core | OTA job notification |

Mobile control path stays: `mobile -> API Gateway -> POST /devices/{id}/shadow -> backend UpdateThingShadow`.

## Mobile Realtime Standard (WSS)

- Mobile must use MQTT over WebSocket (`wss`) with Cognito Identity Pool temporary credentials and SigV4 URL signing.
- Device firmware remains `mqtts` + X.509 on port `8883`; this is independent from the mobile transport.
- Cognito authenticated IAM policy should stay scoped to required IoT `client`, `topicfilter`, and `topic` ARNs for app realtime topics.

## Realtime Validation Checklist

- Login succeeds and mobile establishes `wss` connection to IoT Data endpoint.
- Dashboard receives `devices/+/status` updates in realtime.
- Monitoring receives `devices/{id}/telemetry` updates in realtime.
- Shadow hook receives both accepted/rejected topics and no longer misses initial `shadow/get` response.
- Device control via REST (`POST /devices/{id}/shadow`) still works end-to-end.

## Smart Scene Example

```json
{
  "userId":  "user-abc",
  "sceneId": "scene-001",
  "name":    "Night Mode",
  "enabled": "true",
  "trigger": {
    "type":         "schedule",
    "cron":         "0 15 * * *",
    "scheduleName": "Night Mode"
  },
  "actions": [
    { "deviceId": "switch-AABBCC", "state": { "relay": "OFF" } }
  ]
}
```
