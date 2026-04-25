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

/* Amazon Root CA only (public). Ephemeral claim PEM comes from NVS (Trusted User). */
extern const uint8_t root_ca_pem_start[] asm("_binary_root_ca_pem_start");
extern const uint8_t root_ca_pem_end[]   asm("_binary_root_ca_pem_end");

#define PROV_DONE_BIT   BIT0
#define PROV_FAIL_BIT   BIT1

static EventGroupHandle_t s_prov_events;
static char s_new_cert_id[128];
/* AWS certificateOwnershipToken can be long (JWT-like). Keep ample room. */
static char s_cert_ownership_token[2048];
static char s_new_cert_pem[4096];
static char s_new_private_key[2048];
static char s_thing_name[64];

/* Buffers for claim cert loaded from NVS (not embedded at factory). */
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
    esp_err_t stop_err = esp_mqtt_client_stop(client);
    if (stop_err != ESP_OK && stop_err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "esp_mqtt_client_stop returned: %s", esp_err_to_name(stop_err));
    }
    esp_err_t destroy_err = esp_mqtt_client_destroy(client);
    if (destroy_err != ESP_OK) {
        ESP_LOGW(TAG, "esp_mqtt_client_destroy returned: %s", esp_err_to_name(destroy_err));
    }
}

bool provisioning_set_trusted_user_credentials(const char *cert_pem,
    const char *private_key_pem, const char *iot_data_endpoint_host,
    const char *claim_id)
{
    if (!cert_pem || !private_key_pem || !iot_data_endpoint_host || !claim_id
        || cert_pem[0] == '\0' || private_key_pem[0] == '\0'
        || iot_data_endpoint_host[0] == '\0' || claim_id[0] == '\0') {
        return false;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }

    esp_err_t err = nvs_set_str(nvs, NVS_KEY_CLAIM_CERT, cert_pem);
    if (err == ESP_OK) err = nvs_set_str(nvs, NVS_KEY_CLAIM_KEY, private_key_pem);
    if (err == ESP_OK) err = nvs_set_str(nvs, NVS_KEY_IOT_HOST, iot_data_endpoint_host);
    if (err == ESP_OK) err = nvs_set_str(nvs, NVS_KEY_CLAIM_ID, claim_id);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to store Trusted User claim: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "Trusted User claim credentials stored (use within claim validity window)");
    return true;
}

bool provisioning_set_wifi_credentials(const char *ssid, const char *password)
{
    if (!ssid || ssid[0] == '\0') {
        ESP_LOGE(TAG, "WiFi SSID is required");
        return false;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS for WiFi credentials");
        return false;
    }

    esp_err_t err = nvs_set_str(nvs, NVS_KEY_WIFI_SSID, ssid);
    if (err == ESP_OK) {
        err = nvs_set_str(nvs, NVS_KEY_WIFI_PASS, password ? password : "");
    }
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to store WiFi credentials: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "WiFi credentials stored in NVS (SSID length: %u)", (unsigned)strlen(ssid));
    return true;
}

bool provisioning_get_wifi_credentials(char *ssid, size_t ssid_len,
    char *password, size_t password_len)
{
    if (!ssid || !password || ssid_len == 0 || password_len == 0) {
        return false;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }

    esp_err_t s_err = nvs_get_str(nvs, NVS_KEY_WIFI_SSID, ssid, &ssid_len);
    esp_err_t p_err = nvs_get_str(nvs, NVS_KEY_WIFI_PASS, password, &password_len);
    nvs_close(nvs);

    if (s_err != ESP_OK || p_err != ESP_OK || ssid[0] == '\0') {
        return false;
    }
    return true;
}

static bool load_claim_from_nvs(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }

    size_t clen = sizeof(s_claim_cert);
    size_t klen = sizeof(s_claim_key);
    size_t hlen = sizeof(s_iot_host);
    size_t ilen = sizeof(s_claim_id);

    s_claim_cert[0] = s_claim_key[0] = s_iot_host[0] = s_claim_id[0] = '\0';

    if (nvs_get_str(nvs, NVS_KEY_CLAIM_CERT, s_claim_cert, &clen) != ESP_OK) {
        nvs_close(nvs);
        return false;
    }
    if (nvs_get_str(nvs, NVS_KEY_CLAIM_KEY, s_claim_key, &klen) != ESP_OK) {
        nvs_close(nvs);
        return false;
    }
    hlen = sizeof(s_iot_host);
    if (nvs_get_str(nvs, NVS_KEY_IOT_HOST, s_iot_host, &hlen) != ESP_OK) {
        strncpy(s_iot_host, AWS_IOT_ENDPOINT, sizeof(s_iot_host) - 1);
    }
    ilen = sizeof(s_claim_id);
    if (nvs_get_str(nvs, NVS_KEY_CLAIM_ID, s_claim_id, &ilen) != ESP_OK) {
        nvs_close(nvs);
        return false;
    }
    nvs_close(nvs);
    return s_claim_cert[0] && s_claim_key[0] && s_claim_id[0];
}

bool provisioning_has_claim_credentials(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }

    size_t len = 0;
    esp_err_t c1 = nvs_get_str(nvs, NVS_KEY_CLAIM_CERT, NULL, &len);
    esp_err_t c2 = nvs_get_str(nvs, NVS_KEY_CLAIM_KEY, NULL, &len);
    esp_err_t c3 = nvs_get_str(nvs, NVS_KEY_CLAIM_ID, NULL, &len);
    nvs_close(nvs);
    return c1 == ESP_OK && c2 == ESP_OK && c3 == ESP_OK;
}

static void clear_claim_nvs(void)
{
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_erase_key(nvs, NVS_KEY_CLAIM_CERT);
    nvs_erase_key(nvs, NVS_KEY_CLAIM_KEY);
    nvs_erase_key(nvs, NVS_KEY_IOT_HOST);
    nvs_erase_key(nvs, NVS_KEY_CLAIM_ID);
    nvs_commit(nvs);
    nvs_close(nvs);
}

void provisioning_clear_claim_credentials(void)
{
    clear_claim_nvs();
    memset(s_claim_cert, 0, sizeof(s_claim_cert));
    memset(s_claim_key, 0, sizeof(s_claim_key));
    memset(s_claim_id, 0, sizeof(s_claim_id));
    memset(s_iot_host, 0, sizeof(s_iot_host));
    ESP_LOGI(TAG, "Temporary claim credentials cleared");
}

/* ── MQTT event handler used only during provisioning ─────────────────── */
static void process_prov_mqtt_message(const char *topic, const char *payload)
{
    if (strstr(topic, "accepted") && strstr(topic, "certificates/create")) {
        cJSON *root = cJSON_Parse(payload);
        if (root) {
            cJSON *cert_id = cJSON_GetObjectItem(root, "certificateId");
            cJSON *token = cJSON_GetObjectItem(root, "certificateOwnershipToken");
            cJSON *cert_pem = cJSON_GetObjectItem(root, "certificatePem");
            cJSON *priv_key = cJSON_GetObjectItem(root, "privateKey");
            if (cJSON_IsString(cert_pem) && cJSON_IsString(priv_key)
                && (cJSON_IsString(token) || cJSON_IsString(cert_id))) {
                if (cJSON_IsString(cert_id)) {
                    strncpy(s_new_cert_id, cert_id->valuestring, sizeof(s_new_cert_id) - 1);
                }
                if (cJSON_IsString(token)) {
                        if (strlen(token->valuestring) >= sizeof(s_cert_ownership_token)) {
                            ESP_LOGE(TAG, "certificateOwnershipToken too long for buffer (%u)",
                                     (unsigned)strlen(token->valuestring));
                            cJSON_Delete(root);
                            xEventGroupSetBits(s_prov_events, PROV_FAIL_BIT);
                            return;
                        }
                    strncpy(s_cert_ownership_token, token->valuestring,
                            sizeof(s_cert_ownership_token) - 1);
                } else {
                    strncpy(s_cert_ownership_token, s_new_cert_id,
                            sizeof(s_cert_ownership_token) - 1);
                }
                strncpy(s_new_cert_pem, cert_pem->valuestring, sizeof(s_new_cert_pem) - 1);
                strncpy(s_new_private_key, priv_key->valuestring, sizeof(s_new_private_key) - 1);
                ESP_LOGI(TAG, "Got new certificate: %s", s_new_cert_id[0] ? s_new_cert_id : "(no-id)");
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
        ESP_LOGE(TAG, "Provisioning rejected on topic %s: %s", topic, payload);
        xEventGroupSetBits(s_prov_events, PROV_FAIL_BIT);
    }
}

static void prov_mqtt_event_handler(void *arg, esp_event_base_t base,
                                    int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    if (event_id != MQTT_EVENT_DATA) return;

    if (event->current_data_offset == 0) {
        snprintf(s_rx_topic, sizeof(s_rx_topic), "%.*s", event->topic_len, event->topic);
        s_rx_len = 0;
        s_rx_expected_len = (size_t)event->total_data_len;
    }

    if ((size_t)event->current_data_offset != s_rx_len) {
        ESP_LOGW(TAG, "MQTT chunk offset mismatch topic=%s offset=%d expected=%u",
                 s_rx_topic, event->current_data_offset, (unsigned)s_rx_len);
        s_rx_len = 0;
        return;
    }
    if (s_rx_len + (size_t)event->data_len >= sizeof(s_rx_payload)) {
        ESP_LOGE(TAG, "MQTT payload too large for buffer topic=%s", s_rx_topic);
        s_rx_len = 0;
        xEventGroupSetBits(s_prov_events, PROV_FAIL_BIT);
        return;
    }

    memcpy(s_rx_payload + s_rx_len, event->data, (size_t)event->data_len);
    s_rx_len += (size_t)event->data_len;
    s_rx_payload[s_rx_len] = '\0';

    if (s_rx_len < s_rx_expected_len) {
        return;
    }

    process_prov_mqtt_message(s_rx_topic, s_rx_payload);
    s_rx_len = 0;
    s_rx_expected_len = 0;
    s_rx_topic[0] = '\0';
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
    ESP_LOGI(TAG, "Starting Fleet Provisioning (Trusted User / NVS claim)");
    s_prov_events = xEventGroupCreate();

    s_new_cert_id[0] = '\0';
    s_cert_ownership_token[0] = '\0';
    s_new_cert_pem[0] = '\0';
    s_new_private_key[0] = '\0';
    s_thing_name[0] = '\0';

    if (!load_claim_from_nvs()) {
        ESP_LOGE(TAG,
            "No Trusted User claim in NVS. Use the app (POST /devices/provisioning-claim) "
            "and transfer cert/key + endpoint + claimId, then provisioning_set_trusted_user_credentials()");
        return false;
    }

    char uri[200];
    snprintf(uri, sizeof(uri), "mqtts://%s:%d", s_iot_host, AWS_IOT_PORT);

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address.uri      = uri,
            .address.port     = AWS_IOT_PORT,
            .verification.certificate = (const char *)root_ca_pem_start,
        },
        .credentials = {
            .client_id   = "claim-" CONFIG_IDF_TARGET,
            .authentication = {
                .certificate = s_claim_cert,
                .key         = s_claim_key,
            },
        },
    };

    esp_mqtt_client_handle_t client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID,
                                   prov_mqtt_event_handler, NULL);
    esp_mqtt_client_start(client);
    vTaskDelay(pdMS_TO_TICKS(3000));

    esp_mqtt_client_subscribe(client, PROV_CERT_ACCEPTED_TOPIC, 1);
    esp_mqtt_client_subscribe(client, PROV_CERT_REJECTED_TOPIC, 1);
    esp_mqtt_client_publish(client, PROV_CERT_CREATE_TOPIC, "{}", 2, 1, 0);
    vTaskDelay(pdMS_TO_TICKS(5000));

    if (s_cert_ownership_token[0] == '\0' || s_new_cert_pem[0] == '\0' || s_new_private_key[0] == '\0') {
        ESP_LOGE(TAG, "Failed to obtain new certificate (check claim validity, ~5 min)");
        provisioning_mqtt_shutdown(client);
        return false;
    }

    char prov_topic[256];
    char prov_accept[272];
    char prov_reject[272];
    snprintf(prov_topic,  sizeof(prov_topic),
             "$aws/provisioning-templates/%s/provision/json", PROV_TEMPLATE_NAME);
    snprintf(prov_accept, sizeof(prov_accept), "%s/accepted", prov_topic);
    snprintf(prov_reject, sizeof(prov_reject), "%s/rejected", prov_topic);

    esp_mqtt_client_subscribe(client, prov_accept, 1);
    esp_mqtt_client_subscribe(client, prov_reject, 1);

    cJSON *payload = cJSON_CreateObject();
    cJSON_AddStringToObject(payload, "certificateOwnershipToken",
                            s_cert_ownership_token);
    cJSON *params = cJSON_AddObjectToObject(payload, "parameters");
    cJSON_AddStringToObject(params, "ClaimId",         s_claim_id);
    cJSON_AddStringToObject(params, "DeviceType",      DEVICE_TYPE);
    cJSON_AddStringToObject(params, "FirmwareVersion", FIRMWARE_VERSION);

    char *body = cJSON_PrintUnformatted(payload);
    esp_mqtt_client_publish(client, prov_topic, body, strlen(body), 1, 0);
    free(body);
    cJSON_Delete(payload);

    EventBits_t bits = xEventGroupWaitBits(s_prov_events,
                                           PROV_DONE_BIT | PROV_FAIL_BIT,
                                           pdTRUE, pdFALSE,
                                           pdMS_TO_TICKS(15000));

    provisioning_mqtt_shutdown(client);

    if (!(bits & PROV_DONE_BIT)) {
        ESP_LOGE(TAG, "Provisioning timed out or failed");
        return false;
    }

    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs));
    ESP_ERROR_CHECK(nvs_set_str(nvs, NVS_KEY_THING_NAME, s_thing_name));
    ESP_ERROR_CHECK(nvs_set_str(nvs, NVS_KEY_CERT_PEM,   s_new_cert_pem));
    ESP_ERROR_CHECK(nvs_set_str(nvs, NVS_KEY_PRIVATE_KEY, s_new_private_key));
    ESP_ERROR_CHECK(nvs_set_u8(nvs,  NVS_KEY_PROVISIONED, 1));
    ESP_ERROR_CHECK(nvs_commit(nvs));
    nvs_close(nvs);

    clear_claim_nvs();
    memset(s_claim_cert, 0, sizeof(s_claim_cert));
    memset(s_claim_key, 0, sizeof(s_claim_key));
    memset(s_claim_id, 0, sizeof(s_claim_id));

    ESP_LOGI(TAG, "Provisioning complete. Thing: %s", s_thing_name);
    return true;
}
