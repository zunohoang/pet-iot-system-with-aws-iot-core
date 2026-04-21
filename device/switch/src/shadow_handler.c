#include "shadow_handler.h"
#include "relay_control.h"
#include "config.h"
#include "esp_log.h"
#include "cJSON.h"
#include <string.h>
#include <stdio.h>

static const char *TAG = "shadow";

static esp_mqtt_client_handle_t s_client;
static char s_thing_name[64];
static char s_shadow_update_topic[128];
static char s_shadow_delta_topic[128];
static char s_shadow_get_topic[128];
static char s_shadow_get_accepted[128];

void shadow_handler_init(esp_mqtt_client_handle_t client, const char *thing_name) {
    s_client = client;
    strncpy(s_thing_name, thing_name, sizeof(s_thing_name) - 1);

    snprintf(s_shadow_update_topic,    sizeof(s_shadow_update_topic),
             SHADOW_UPDATE_FMT, thing_name);
    snprintf(s_shadow_delta_topic,     sizeof(s_shadow_delta_topic),
             SHADOW_DELTA_FMT, thing_name);
    snprintf(s_shadow_get_topic,       sizeof(s_shadow_get_topic),
             SHADOW_GET_FMT, thing_name);
    snprintf(s_shadow_get_accepted,    sizeof(s_shadow_get_accepted),
             "$aws/things/%s/shadow/get/accepted", thing_name);

    esp_mqtt_client_subscribe(client, s_shadow_delta_topic,    1);
    esp_mqtt_client_subscribe(client, s_shadow_get_accepted,   1);

    ESP_LOGI(TAG, "Shadow handler initialized for %s", thing_name);
}

void shadow_report_state(bool relay_on) {
    cJSON *root     = cJSON_CreateObject();
    cJSON *state    = cJSON_AddObjectToObject(root, "state");
    cJSON *reported = cJSON_AddObjectToObject(state, "reported");
    cJSON_AddStringToObject(reported, "relay",          relay_on ? "ON" : "OFF");
    cJSON_AddStringToObject(reported, "firmwareVersion", FIRMWARE_VERSION);
    cJSON_AddStringToObject(reported, "deviceType",     DEVICE_TYPE);

    char *body = cJSON_PrintUnformatted(root);
    esp_mqtt_client_publish(s_client, s_shadow_update_topic,
                            body, strlen(body), 1, 0);
    free(body);
    cJSON_Delete(root);
}

void shadow_request_get(void) {
    esp_mqtt_client_publish(s_client, s_shadow_get_topic, "{}", 2, 1, 0);
}

/* Called from mqtt_client.c when a delta message arrives */
void shadow_process_delta(const char *payload, int len) {
    char buf[1024] = {0};
    snprintf(buf, sizeof(buf), "%.*s", len, payload);

    cJSON *root  = cJSON_Parse(buf);
    if (!root) return;

    cJSON *state = cJSON_GetObjectItem(root, "state");
    if (state) {
        cJSON *relay = cJSON_GetObjectItem(state, "relay");
        if (relay && cJSON_IsString(relay)) {
            bool turn_on = strcmp(relay->valuestring, "ON") == 0;
            ESP_LOGI(TAG, "Shadow delta: relay -> %s", relay->valuestring);
            relay_set(turn_on);
            shadow_report_state(turn_on);
        }
    }

    cJSON_Delete(root);
}
