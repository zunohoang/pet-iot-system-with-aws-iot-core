#pragma once

/* ── WiFi credentials ────────────────────────────────────────────────── */
#define WIFI_SSID        "YOUR_WIFI_SSID"
#define WIFI_PASSWORD    "YOUR_WIFI_PASSWORD"

/* ── AWS IoT Core endpoint ───────────────────────────────────────────── */
#define AWS_IOT_ENDPOINT "YOUR_ENDPOINT.iot.ap-southeast-1.amazonaws.com"
#define AWS_IOT_PORT     8883

/* ── Device identity ────────────────────────────────────────────────── */
#define DEVICE_TYPE      "switch"
#define FIRMWARE_VERSION "1.0.0"

/* ── GPIO ────────────────────────────────────────────────────────────── */
#define RELAY_GPIO       GPIO_NUM_26
#define STATUS_LED_GPIO  GPIO_NUM_2

/* ── MQTT topics (populated at runtime with thingName) ──────────────── */
#define TOPIC_TELEMETRY_FMT  "devices/%s/telemetry"
#define TOPIC_STATUS_FMT     "devices/%s/status"
#define TOPIC_CONTROL_FMT    "devices/%s/control"
#define SHADOW_UPDATE_FMT    "$aws/things/%s/shadow/update"
#define SHADOW_DELTA_FMT     "$aws/things/%s/shadow/update/delta"
#define SHADOW_GET_FMT       "$aws/things/%s/shadow/get"

/* ── Provisioning topics ─────────────────────────────────────────────── */
#define PROV_CERT_CREATE_TOPIC    "$aws/certificates/create/json"
#define PROV_CERT_ACCEPTED_TOPIC  "$aws/certificates/create/json/accepted"
#define PROV_CERT_REJECTED_TOPIC  "$aws/certificates/create/json/rejected"
#define PROV_TEMPLATE_NAME        "iot-smarthome-SwitchTemplate"

/* ── NVS storage keys ───────────────────────────────────────────────── */
#define NVS_NAMESPACE        "iot_cfg"
#define NVS_KEY_THING_NAME   "thing_name"
#define NVS_KEY_PROVISIONED  "provisioned"
#define NVS_KEY_CERT_PEM     "cert_pem"
#define NVS_KEY_PRIVATE_KEY  "priv_key"

/* ── Timings ─────────────────────────────────────────────────────────── */
#define STATUS_PUBLISH_INTERVAL_MS  30000
#define SHADOW_GET_INTERVAL_MS      60000
#define MQTT_RECONNECT_DELAY_MS     5000
