#include "provisioning.h"
#include "config.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_event.h"
#include "nvs_flash.h"
#include "nvs.h"
#include <mqtt_client.h>
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static const char *TAG = "provisioning";

extern const uint8_t root_ca_pem_start[] asm("_binary_root_ca_pem_start");
extern const uint8_t root_ca_pem_end[]   asm("_binary_root_ca_pem_end");

#define PROV_DONE_BIT   BIT0
#define PROV_FAIL_BIT   BIT1

static EventGroupHandle_t s_prov_events;
static char s_cert_ownership_token[2048];
static char s_new_cert_pem[4096];
static char s_new_private_key[2048];
static char s_thing_name[64];

static char s_claim_cert[4096];
static char s_claim_key[2048];
static char s_iot_host[128];
static char s_claim_id[128];
static char s_rx_topic[256];
static char s_rx_payload[12288];
static size_t s_rx_len = 0;
static size_t s_rx_expected_len = 0;

static void provisioning_mqtt_shutdown(esp_mqtt_client_handle_t client)
{
    if (!client) return;
    esp_mqtt_client_stop(client);
    esp_mqtt_client_destroy(client);
}

bool provisioning_set_trusted_user_credentials(const char *cert_pem,
    const char *private_key_pem, const char *iot_data_endpoint_host,
    const char *claim_id)
{
    if (!cert_pem || !private_key_pem || !iot_data_endpoint_host || !claim_id) return false;
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) return false;
    nvs_set_str(nvs, NVS_KEY_CLAIM_CERT, cert_pem);
    nvs_set_str(nvs, NVS_KEY_CLAIM_KEY, private_key_pem);
    nvs_set_str(nvs, NVS_KEY_IOT_HOST, iot_data_endpoint_host);
    nvs_set_str(nvs, NVS_KEY_CLAIM_ID, claim_id);
    nvs_commit(nvs);
    nvs_close(nvs);
    return true;
}

bool provisioning_set_wifi_credentials(const char *ssid, const char *password)
{
    if (!ssid) return false;
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) return false;
    nvs_set_str(nvs, NVS_KEY_WIFI_SSID, ssid);
    nvs_set_str(nvs, NVS_KEY_WIFI_PASS, password ? password : "");
    nvs_commit(nvs);
    nvs_close(nvs);
    return true;
}

bool provisioning_get_wifi_credentials(char *ssid, size_t ssid_len,
    char *password, size_t password_len)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) return false;
    esp_err_t s_err = nvs_get_str(nvs, NVS_KEY_WIFI_SSID, ssid, &ssid_len);
    esp_err_t p_err = nvs_get_str(nvs, NVS_KEY_WIFI_PASS, password, &password_len);
    nvs_close(nvs);
    return (s_err == ESP_OK && p_err == ESP_OK);
}

static bool load_claim_from_nvs(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t clen = sizeof(s_claim_cert);
    size_t klen = sizeof(s_claim_key);
    size_t hlen = sizeof(s_iot_host);
    size_t ilen = sizeof(s_claim_id);
    nvs_get_str(nvs, NVS_KEY_CLAIM_CERT, s_claim_cert, &clen);
    nvs_get_str(nvs, NVS_KEY_CLAIM_KEY, s_claim_key, &klen);
    nvs_get_str(nvs, NVS_KEY_IOT_HOST, s_iot_host, &hlen);
    nvs_get_str(nvs, NVS_KEY_CLAIM_ID, s_claim_id, &ilen);
    nvs_close(nvs);
    return (s_claim_cert[0] != '\0' && s_claim_key[0] != '\0' && s_claim_id[0] != '\0');
}

bool provisioning_has_claim_credentials(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) return false;
    size_t len = 0;
    esp_err_t c1 = nvs_get_str(nvs, NVS_KEY_CLAIM_CERT, NULL, &len);
    nvs_close(nvs);
    return c1 == ESP_OK;
}

void provisioning_clear_claim_credentials(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_erase_key(nvs, NVS_KEY_CLAIM_CERT);
        nvs_erase_key(nvs, NVS_KEY_CLAIM_KEY);
        nvs_erase_key(nvs, NVS_KEY_CLAIM_ID);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

static void process_prov_mqtt_message(const char *topic, const char *payload)
{
    if (strstr(topic, "accepted") && strstr(topic, "certificates/create")) {
        cJSON *root = cJSON_Parse(payload);
        if (root) {
            cJSON *token = cJSON_GetObjectItem(root, "certificateOwnershipToken");
            cJSON *cert_pem = cJSON_GetObjectItem(root, "certificatePem");
            cJSON *priv_key = cJSON_GetObjectItem(root, "privateKey");
            if (token && cert_pem && priv_key) {
                strncpy(s_cert_ownership_token, token->valuestring, sizeof(s_cert_ownership_token)-1);
                strncpy(s_new_cert_pem, cert_pem->valuestring, sizeof(s_new_cert_pem)-1);
                strncpy(s_new_private_key, priv_key->valuestring, sizeof(s_new_private_key)-1);
                ESP_LOGI(TAG, "New certificate material received");
            }
            cJSON_Delete(root);
        }
    } else if (strstr(topic, "provision") && strstr(topic, "accepted")) {
        cJSON *root = cJSON_Parse(payload);
        if (root) {
            cJSON *thing = cJSON_GetObjectItem(root, "thingName");
            if (thing) {
                strncpy(s_thing_name, thing->valuestring, sizeof(s_thing_name)-1);
                ESP_LOGI(TAG, "Provisioning complete! ThingName: %s", s_thing_name);
                xEventGroupSetBits(s_prov_events, PROV_DONE_BIT);
            }
            cJSON_Delete(root);
        }
    } else if (strstr(topic, "rejected")) {
        ESP_LOGE(TAG, "Provisioning rejected: %s", payload);
        xEventGroupSetBits(s_prov_events, PROV_FAIL_BIT);
    }
}

static void prov_mqtt_event_handler(void *arg, esp_event_base_t base,
                                    int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    if (event_id == MQTT_EVENT_CONNECTED) {
        ESP_LOGI(TAG, "Provisioning MQTT Connected");
    } else if (event_id == MQTT_EVENT_DATA) {
        if (event->current_data_offset == 0) {
            snprintf(s_rx_topic, sizeof(s_rx_topic), "%.*s", event->topic_len, event->topic);
            s_rx_len = 0;
            s_rx_expected_len = (size_t)event->total_data_len;
        }
        if (s_rx_len + event->data_len < sizeof(s_rx_payload)) {
            memcpy(s_rx_payload + s_rx_len, event->data, event->data_len);
            s_rx_len += event->data_len;
            s_rx_payload[s_rx_len] = '\0';
        }
        if (s_rx_len >= s_rx_expected_len) {
            process_prov_mqtt_message(s_rx_topic, s_rx_payload);
        }
    } else if (event_id == MQTT_EVENT_DISCONNECTED) {
        ESP_LOGW(TAG, "Provisioning MQTT Disconnected");
    }
}

bool provisioning_is_done(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) return false;
    uint8_t provisioned = 0;
    nvs_get_u8(nvs, NVS_KEY_PROVISIONED, &provisioned);
    nvs_close(nvs);
    return provisioned == 1;
}

bool provisioning_get_thing_name(char *buf, size_t len) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) return false;
    esp_err_t err = nvs_get_str(nvs, NVS_KEY_THING_NAME, buf, &len);
    nvs_close(nvs);
    return err == ESP_OK;
}

bool provisioning_run(void) {
    s_prov_events = xEventGroupCreate();
    s_cert_ownership_token[0] = '\0';
    if (!load_claim_from_nvs()) return false;

    char uri[200];
    snprintf(uri, sizeof(uri), "mqtts://%s:%d", s_iot_host, AWS_IOT_PORT);

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address = {
                .uri = uri,
                .port = AWS_IOT_PORT,
            },
            .verification = {
                .certificate = (const char *)root_ca_pem_start,
            }
        },
        .credentials = {
            .client_id = "claim-sensor",
            .authentication = {
                .certificate = s_claim_cert,
                .key = s_claim_key,
            }
        }
    };

    ESP_LOGI(TAG, "Connecting to provisioning endpoint: %s", uri);
    esp_mqtt_client_handle_t client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, prov_mqtt_event_handler, NULL);
    esp_mqtt_client_start(client);
    vTaskDelay(pdMS_TO_TICKS(5000));

    ESP_LOGI(TAG, "Step 1: Requesting temporary certificate materials...");
    esp_mqtt_client_subscribe(client, PROV_CERT_ACCEPTED_TOPIC, 1);
    esp_mqtt_client_subscribe(client, PROV_CERT_REJECTED_TOPIC, 1);
    esp_mqtt_client_publish(client, PROV_CERT_CREATE_TOPIC, "{}", 2, 1, 0);
    
    // Wait for the material to be received and parsed
    int retry = 0;
    while (s_cert_ownership_token[0] == '\0' && retry < 20) {
        vTaskDelay(pdMS_TO_TICKS(500));
        retry++;
    }

    if (s_cert_ownership_token[0] == '\0') {
        ESP_LOGE(TAG, "Failed to obtain temporary certificate materials (timeout)");
        provisioning_mqtt_shutdown(client);
        return false;
    }

    ESP_LOGI(TAG, "Step 2: Sending provisioning request with token...");
    char prov_topic[256];
    char prov_accept[300];
    char prov_reject[300];
    snprintf(prov_topic, sizeof(prov_topic), "$aws/provisioning-templates/%s/provision/json", PROV_TEMPLATE_NAME);
    snprintf(prov_accept, sizeof(prov_accept), "%s/accepted", prov_topic);
    snprintf(prov_reject, sizeof(prov_reject), "%s/rejected", prov_topic);

    esp_mqtt_client_subscribe(client, prov_accept, 1);
    esp_mqtt_client_subscribe(client, prov_reject, 1);

    cJSON *payload = cJSON_CreateObject();
    cJSON_AddStringToObject(payload, "certificateOwnershipToken", s_cert_ownership_token);
    cJSON *params = cJSON_AddObjectToObject(payload, "parameters");
    cJSON_AddStringToObject(params, "ClaimId", s_claim_id);
    cJSON_AddStringToObject(params, "DeviceType", DEVICE_TYPE);

    char *body = cJSON_PrintUnformatted(payload);
    esp_mqtt_client_publish(client, prov_topic, body, strlen(body), 1, 0);
    free(body);
    cJSON_Delete(payload);

    EventBits_t bits = xEventGroupWaitBits(s_prov_events, PROV_DONE_BIT | PROV_FAIL_BIT, pdTRUE, pdFALSE, pdMS_TO_TICKS(15000));
    provisioning_mqtt_shutdown(client);

    if (bits & PROV_DONE_BIT) {
        nvs_handle_t nvs;
        if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
            nvs_set_str(nvs, NVS_KEY_THING_NAME, s_thing_name);
            nvs_set_str(nvs, NVS_KEY_CERT_PEM, s_new_cert_pem);
            nvs_set_str(nvs, NVS_KEY_PRIVATE_KEY, s_new_private_key);
            nvs_set_u8(nvs, NVS_KEY_PROVISIONED, 1);
            nvs_commit(nvs);
            nvs_close(nvs);
            provisioning_clear_claim_credentials();
            return true;
        }
    }
    return false;
}
