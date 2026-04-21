#include "provisioning.h"
#include "config.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "mqtt_client.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include <string.h>
#include <stdlib.h>

static const char *TAG = "provisioning";

/* Claim certificate and private key are embedded at build time via
 * idf_component_register(EMBED_FILES ...) in CMakeLists.txt.
 * They are the shared "fleet claim" credentials, not device-specific. */
extern const uint8_t claim_cert_pem_start[]   asm("_binary_claim_cert_pem_start");
extern const uint8_t claim_cert_pem_end[]     asm("_binary_claim_cert_pem_end");
extern const uint8_t claim_private_key_start[] asm("_binary_claim_private_key_start");
extern const uint8_t claim_private_key_end[]   asm("_binary_claim_private_key_end");
extern const uint8_t root_ca_pem_start[]       asm("_binary_root_ca_pem_start");
extern const uint8_t root_ca_pem_end[]         asm("_binary_root_ca_pem_end");

#define PROV_DONE_BIT   BIT0
#define PROV_FAIL_BIT   BIT1

static EventGroupHandle_t s_prov_events;
static char s_new_cert_id[128];
static char s_new_cert_pem[4096];
static char s_new_private_key[2048];
static char s_thing_name[64];

/* ── MQTT event handler used only during provisioning ─────────────────── */
static void prov_mqtt_event_handler(void *arg, esp_event_base_t base,
                                    int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;

    if (event_id == MQTT_EVENT_DATA) {
        char topic[256] = {0};
        char payload[8192] = {0};
        snprintf(topic,   sizeof(topic),   "%.*s", event->topic_len,   event->topic);
        snprintf(payload, sizeof(payload), "%.*s", event->data_len,    event->data);

        if (strstr(topic, "accepted") && strstr(topic, "certificates/create")) {
            /* Parse new certificate from response */
            cJSON *root = cJSON_Parse(payload);
            if (root) {
                cJSON *cert_id  = cJSON_GetObjectItem(root, "certificateId");
                cJSON *cert_pem = cJSON_GetObjectItem(root, "certificatePem");
                cJSON *priv_key = cJSON_GetObjectItem(root, "privateKey");
                if (cert_id && cert_pem && priv_key) {
                    strncpy(s_new_cert_id,     cert_id->valuestring,  sizeof(s_new_cert_id) - 1);
                    strncpy(s_new_cert_pem,    cert_pem->valuestring, sizeof(s_new_cert_pem) - 1);
                    strncpy(s_new_private_key, priv_key->valuestring, sizeof(s_new_private_key) - 1);
                    ESP_LOGI(TAG, "Got new certificate: %s", s_new_cert_id);
                }
                cJSON_Delete(root);
            }
        } else if (strstr(topic, "provision") && strstr(topic, "accepted")) {
            cJSON *root = cJSON_Parse(payload);
            if (root) {
                cJSON *thing = cJSON_GetObjectItem(root, "thingName");
                if (thing) {
                    strncpy(s_thing_name, thing->valuestring, sizeof(s_thing_name) - 1);
                    ESP_LOGI(TAG, "Provisioned as Thing: %s", s_thing_name);
                    xEventGroupSetBits(s_prov_events, PROV_DONE_BIT);
                }
                cJSON_Delete(root);
            }
        } else if (strstr(topic, "rejected")) {
            ESP_LOGE(TAG, "Provisioning rejected: %s", payload);
            xEventGroupSetBits(s_prov_events, PROV_FAIL_BIT);
        }
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
    ESP_LOGI(TAG, "Starting Fleet Provisioning with claim certificate");
    s_prov_events = xEventGroupCreate();

    /* Connect with claim certificate */
    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address.uri      = "mqtts://" AWS_IOT_ENDPOINT,
            .address.port     = AWS_IOT_PORT,
            .verification.certificate = (const char *)root_ca_pem_start,
        },
        .credentials = {
            .id          = "claim-" CONFIG_IDF_TARGET,
            .authentication = {
                .certificate = (const char *)claim_cert_pem_start,
                .key         = (const char *)claim_private_key_start,
            },
        },
    };

    esp_mqtt_client_handle_t client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID,
                                   prov_mqtt_event_handler, NULL);
    esp_mqtt_client_start(client);
    vTaskDelay(pdMS_TO_TICKS(3000));

    /* Step 1: Request a new certificate */
    esp_mqtt_client_subscribe(client, PROV_CERT_ACCEPTED_TOPIC, 1);
    esp_mqtt_client_subscribe(client, PROV_CERT_REJECTED_TOPIC, 1);
    esp_mqtt_client_publish(client, PROV_CERT_CREATE_TOPIC, "{}", 2, 1, 0);
    vTaskDelay(pdMS_TO_TICKS(5000));

    if (s_new_cert_id[0] == '\0') {
        ESP_LOGE(TAG, "Failed to obtain new certificate");
        esp_mqtt_client_destroy(client);
        return false;
    }

    /* Step 2: Register Thing via provisioning template */
    char prov_topic[256];
    char prov_accept[256];
    char prov_reject[256];
    snprintf(prov_topic,  sizeof(prov_topic),
             "$aws/provisioning-templates/%s/provision/json", PROV_TEMPLATE_NAME);
    snprintf(prov_accept, sizeof(prov_accept), "%s/accepted", prov_topic);
    snprintf(prov_reject, sizeof(prov_reject), "%s/rejected", prov_topic);

    esp_mqtt_client_subscribe(client, prov_accept, 1);
    esp_mqtt_client_subscribe(client, prov_reject, 1);

    /* Build register payload */
    char serial[32];
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(serial, sizeof(serial), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    cJSON *payload = cJSON_CreateObject();
    cJSON_AddStringToObject(payload, "certificateOwnershipToken",
                            s_new_cert_id);
    cJSON *params = cJSON_AddObjectToObject(payload, "parameters");
    cJSON_AddStringToObject(params, "SerialNumber",    serial);
    cJSON_AddStringToObject(params, "DeviceType",      DEVICE_TYPE);
    cJSON_AddStringToObject(params, "FirmwareVersion", FIRMWARE_VERSION);

    char *body = cJSON_PrintUnformatted(payload);
    esp_mqtt_client_publish(client, prov_topic, body, strlen(body), 1, 0);
    free(body);
    cJSON_Delete(payload);

    /* Wait for provisioning result */
    EventBits_t bits = xEventGroupWaitBits(s_prov_events,
                                           PROV_DONE_BIT | PROV_FAIL_BIT,
                                           pdTRUE, pdFALSE,
                                           pdMS_TO_TICKS(15000));

    esp_mqtt_client_destroy(client);

    if (!(bits & PROV_DONE_BIT)) {
        ESP_LOGE(TAG, "Provisioning timed out or failed");
        return false;
    }

    /* Step 3: Persist permanent cert + key + thing name to NVS */
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs));
    ESP_ERROR_CHECK(nvs_set_str(nvs, NVS_KEY_THING_NAME, s_thing_name));
    ESP_ERROR_CHECK(nvs_set_str(nvs, NVS_KEY_CERT_PEM,   s_new_cert_pem));
    ESP_ERROR_CHECK(nvs_set_str(nvs, NVS_KEY_PRIVATE_KEY, s_new_private_key));
    ESP_ERROR_CHECK(nvs_set_u8(nvs,  NVS_KEY_PROVISIONED, 1));
    ESP_ERROR_CHECK(nvs_commit(nvs));
    nvs_close(nvs);

    ESP_LOGI(TAG, "Provisioning complete. Thing: %s", s_thing_name);
    return true;
}
