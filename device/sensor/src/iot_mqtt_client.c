#include "iot_mqtt_client.h"
#include "shadow_handler.h"
#include "config.h"
#include "esp_log.h"
#include <mqtt_client.h>
#include "esp_event.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdio.h>
#include <string.h>

static const char *TAG = "mqtt";

extern const uint8_t root_ca_pem_start[] asm("_binary_root_ca_pem_start");

static esp_mqtt_client_handle_t s_client;
static char s_thing_name[64];
static char s_status_topic[128];
static char s_telemetry_topic[128];

static void load_cert_from_nvs(char *cert_pem, size_t cert_len,
                                char *priv_key, size_t key_len) {
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs));
    ESP_ERROR_CHECK(nvs_get_str(nvs, NVS_KEY_CERT_PEM,   cert_pem, &cert_len));
    ESP_ERROR_CHECK(nvs_get_str(nvs, NVS_KEY_PRIVATE_KEY, priv_key, &key_len));
    nvs_close(nvs);
}

static void on_connected(esp_mqtt_client_handle_t client) {
    ESP_LOGI(TAG, "Connected to AWS IoT Core as %s", s_thing_name);

    shadow_handler_init(client, s_thing_name);
    
    /* Initial status report */
    mqtt_publish_status(true);
}

static void on_data(esp_mqtt_client_handle_t client,
                    const char *topic, int topic_len,
                    const char *data,  int data_len) {
    char t[256] = {0};
    snprintf(t, sizeof(t), "%.*s", topic_len, topic);

    if (strstr(t, "shadow/update/delta")) {
        shadow_process_delta(data, data_len);
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
            ESP_LOGW(TAG, "Disconnected from broker");
            break;
        case MQTT_EVENT_DATA:
            on_data(event->client, event->topic, event->topic_len,
                    event->data, event->data_len);
            break;
        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "MQTT error");
            break;
        default:
            break;
    }
}

void mqtt_app_start(const char *thing_name) {
    strncpy(s_thing_name, thing_name, sizeof(s_thing_name) - 1);

    snprintf(s_status_topic,      sizeof(s_status_topic),
             TOPIC_STATUS_FMT, thing_name);
    snprintf(s_telemetry_topic,   sizeof(s_telemetry_topic),
             TOPIC_TELEMETRY_FMT, thing_name);

    static char cert_pem[4096];
    static char priv_key[2048];
    load_cert_from_nvs(cert_pem, sizeof(cert_pem),
                       priv_key, sizeof(priv_key));

    char client_id[80];
    snprintf(client_id, sizeof(client_id), "sensor-%s", thing_name);

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address.uri  = "mqtts://" AWS_IOT_ENDPOINT,
            .address.port = AWS_IOT_PORT,
            .verification.certificate = (const char *)root_ca_pem_start,
        },
        .credentials = {
            .client_id = client_id,
            .authentication = {
                .certificate = cert_pem,
                .key         = priv_key,
            },
        },
    };

    s_client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID,
                                   mqtt_event_handler, NULL);
    esp_mqtt_client_start(s_client);
    ESP_LOGI(TAG, "MQTT client started for %s", thing_name);
}

void mqtt_publish_telemetry(const dht11_reading_t *reading) {
    if (!s_client) return;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId",    s_thing_name);
    cJSON_AddStringToObject(root, "deviceType",  DEVICE_TYPE);
    cJSON_AddNumberToObject(root, "temperature", reading->temperature);
    cJSON_AddNumberToObject(root, "humidity",    reading->humidity);

    char *body = cJSON_PrintUnformatted(root);
    esp_mqtt_client_publish(s_client, s_telemetry_topic, body, strlen(body), 1, 0);
    free(body);
    cJSON_Delete(root);

    /* Also update shadow */
    shadow_report_state(reading->temperature, reading->humidity);
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
