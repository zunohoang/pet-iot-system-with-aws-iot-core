#include "mqtt_client.h"
#include "ota_handler.h"
#include "config.h"
#include "esp_log.h"
#include "esp_mqtt_client.h"
#include "nvs.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

static const char *TAG = "mqtt";

extern const uint8_t root_ca_pem_start[] asm("_binary_root_ca_pem_start");

static esp_mqtt_client_handle_t s_client;
static char s_thing_name[64];
static char s_telemetry_topic[128];
static char s_status_topic[128];
static char s_shadow_update_topic[128];
static char s_jobs_notify_topic[128];

static void load_cert_from_nvs(char *cert, size_t cert_len,
                                char *key,  size_t key_len) {
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs));
    ESP_ERROR_CHECK(nvs_get_str(nvs, NVS_KEY_CERT_PEM,   cert, &cert_len));
    ESP_ERROR_CHECK(nvs_get_str(nvs, NVS_KEY_PRIVATE_KEY, key,  &key_len));
    nvs_close(nvs);
}

static void on_connected(esp_mqtt_client_handle_t client) {
    ESP_LOGI(TAG, "Connected as %s", s_thing_name);
    esp_mqtt_client_subscribe(client, s_jobs_notify_topic, 1);
    mqtt_publish_status(true);
}

static void on_data(const char *topic, int tlen, const char *data, int dlen) {
    char t[256] = {0};
    snprintf(t, sizeof(t), "%.*s", tlen, topic);
    if (strstr(t, "jobs/notify")) {
        ota_handle_job_notification(data, dlen);
    }
}

static void mqtt_event_handler(void *arg, esp_event_base_t base,
                                int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            on_connected(event->client);
            break;
        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "Disconnected");
            break;
        case MQTT_EVENT_DATA:
            on_data(event->topic, event->topic_len,
                    event->data,  event->data_len);
            break;
        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "MQTT error");
            break;
        default: break;
    }
}

void mqtt_app_start(const char *thing_name) {
    strncpy(s_thing_name, thing_name, sizeof(s_thing_name) - 1);

    snprintf(s_telemetry_topic,    sizeof(s_telemetry_topic),
             TOPIC_TELEMETRY_FMT, thing_name);
    snprintf(s_status_topic,       sizeof(s_status_topic),
             TOPIC_STATUS_FMT, thing_name);
    snprintf(s_shadow_update_topic, sizeof(s_shadow_update_topic),
             SHADOW_UPDATE_FMT, thing_name);
    snprintf(s_jobs_notify_topic,  sizeof(s_jobs_notify_topic),
             "$aws/things/%s/jobs/notify", thing_name);

    static char cert_pem[4096];
    static char priv_key[2048];
    load_cert_from_nvs(cert_pem, sizeof(cert_pem),
                       priv_key, sizeof(priv_key));

    char client_id[80];
    snprintf(client_id, sizeof(client_id), "sensor-%s", thing_name);

    esp_mqtt_client_config_t cfg = {
        .broker = {
            .address.uri  = "mqtts://" AWS_IOT_ENDPOINT,
            .address.port = AWS_IOT_PORT,
            .verification.certificate = (const char *)root_ca_pem_start,
        },
        .credentials = {
            .id = client_id,
            .authentication = {
                .certificate = cert_pem,
                .key         = priv_key,
            },
        },
    };

    s_client = esp_mqtt_client_init(&cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID,
                                   mqtt_event_handler, NULL);
    esp_mqtt_client_start(s_client);
    ESP_LOGI(TAG, "MQTT started for %s", thing_name);
}

void mqtt_publish_telemetry(const dht11_reading_t *reading) {
    if (!s_client) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId",    s_thing_name);
    cJSON_AddStringToObject(root, "deviceType",  DEVICE_TYPE);
    cJSON_AddNumberToObject(root, "temperature", reading->temperature);
    cJSON_AddNumberToObject(root, "humidity",    reading->humidity);

    /* Also update shadow reported state */
    cJSON *shadow    = cJSON_CreateObject();
    cJSON *state     = cJSON_AddObjectToObject(shadow, "state");
    cJSON *reported  = cJSON_AddObjectToObject(state, "reported");
    cJSON_AddNumberToObject(reported, "temperature", reading->temperature);
    cJSON_AddNumberToObject(reported, "humidity",    reading->humidity);

    char *telemetry_body = cJSON_PrintUnformatted(root);
    char *shadow_body    = cJSON_PrintUnformatted(shadow);

    esp_mqtt_client_publish(s_client, s_telemetry_topic,
                            telemetry_body, strlen(telemetry_body), 1, 0);
    esp_mqtt_client_publish(s_client, s_shadow_update_topic,
                            shadow_body,    strlen(shadow_body),    1, 0);

    free(telemetry_body);
    free(shadow_body);
    cJSON_Delete(root);
    cJSON_Delete(shadow);
}

void mqtt_publish_status(bool online) {
    if (!s_client) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId",       s_thing_name);
    cJSON_AddStringToObject(root, "deviceType",     DEVICE_TYPE);
    cJSON_AddStringToObject(root, "firmwareVersion", FIRMWARE_VERSION);
    cJSON_AddBoolToObject(root, "online",           online);

    char *body = cJSON_PrintUnformatted(root);
    esp_mqtt_client_publish(s_client, s_status_topic, body, strlen(body), 1, 0);
    free(body);
    cJSON_Delete(root);
}
