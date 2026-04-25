#pragma once

/* ── WiFi credentials ────────────────────────────────────────────────── */
#define WIFI_SSID        "YOUR_WIFI_SSID"
#define WIFI_PASSWORD    "YOUR_WIFI_PASSWORD"

/* ── AWS IoT Core endpoint ───────────────────────────────────────────── */
#define AWS_IOT_ENDPOINT "xxxx.iot.ap-southeast-1.amazonaws.com"
#define AWS_IOT_PORT     8883

/* ── Device identity ────────────────────────────────────────────────── */
#define DEVICE_TYPE      "sensor"
#define FIRMWARE_VERSION "1.0.0"

/* ── GPIO ────────────────────────────────────────────────────────────── */
#define DHT11_GPIO       GPIO_NUM_4
#define STATUS_LED_GPIO  GPIO_NUM_2

/* ── MQTT topics ─────────────────────────────────────────────────────── */
#define TOPIC_TELEMETRY_FMT "devices/%s/telemetry"
#define TOPIC_STATUS_FMT    "devices/%s/status"
#define SHADOW_UPDATE_FMT   "$aws/things/%s/shadow/update"
#define SHADOW_GET_FMT      "$aws/things/%s/shadow/get"
#define SHADOW_DELTA_FMT    "$aws/things/%s/shadow/update/delta"

/* ── Provisioning topics ─────────────────────────────────────────────── */
#define PROV_CERT_CREATE_TOPIC   "$aws/certificates/create/json"
#define PROV_CERT_ACCEPTED_TOPIC "$aws/certificates/create/json/accepted"
#define PROV_CERT_REJECTED_TOPIC "$aws/certificates/create/json/rejected"
#define PROV_TEMPLATE_NAME       "iot-smarthome-SensorTemplate"

/* ── NVS storage keys ───────────────────────────────────────────────── */
#define NVS_NAMESPACE        "iot_cfg"
#define NVS_KEY_THING_NAME   "thing_name"
#define NVS_KEY_PROVISIONED  "provisioned"
#define NVS_KEY_CERT_PEM     "cert_pem"
#define NVS_KEY_PRIVATE_KEY  "priv_key"
#define NVS_KEY_CLAIM_CERT   "claim_cert"
#define NVS_KEY_CLAIM_KEY    "claim_key"
#define NVS_KEY_IOT_HOST     "iot_host"
#define NVS_KEY_CLAIM_ID     "claim_id"
#define NVS_KEY_WIFI_SSID    "wifi_ssid"
#define NVS_KEY_WIFI_PASS    "wifi_pass"

/* ── Timings ─────────────────────────────────────────────────────────── */
#define TELEMETRY_INTERVAL_MS   10000  /* publish sensor data every 10s */
#define STATUS_INTERVAL_MS      30000
#define STATUS_PUBLISH_INTERVAL_MS 30000
#define MQTT_RECONNECT_DELAY_MS 5000

/* ── Alert thresholds ────────────────────────────────────────────────── */
#define TEMP_HIGH_THRESHOLD  35.0f
#define HUMIDITY_HIGH_THRESHOLD 80.0f
