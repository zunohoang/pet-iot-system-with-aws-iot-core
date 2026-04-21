#include "ota_handler.h"
#include "config.h"
#include "esp_log.h"
#include "esp_https_ota.h"
#include "esp_http_client.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <stdlib.h>

static const char *TAG = "ota";

extern const uint8_t root_ca_pem_start[] asm("_binary_root_ca_pem_start");

typedef struct {
    char url[512];
    char version[32];
} ota_job_t;

static void ota_task(void *arg) {
    ota_job_t *job = (ota_job_t *)arg;
    ESP_LOGI(TAG, "OTA update to v%s", job->version);

    esp_http_client_config_t http_cfg = {
        .url      = job->url,
        .cert_pem = (const char *)root_ca_pem_start,
        .timeout_ms = 30000,
    };
    esp_https_ota_config_t ota_cfg = { .http_config = &http_cfg };

    esp_err_t ret = esp_https_ota(&ota_cfg);
    free(job);

    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "OTA OK — restarting");
        esp_restart();
    } else {
        ESP_LOGE(TAG, "OTA failed: %s", esp_err_to_name(ret));
    }
    vTaskDelete(NULL);
}

void ota_handle_job_notification(const char *data, int data_len) {
    char buf[2048] = {0};
    snprintf(buf, sizeof(buf), "%.*s", data_len, data);

    cJSON *root = cJSON_Parse(buf);
    if (!root) return;

    cJSON *jobs = cJSON_GetObjectItem(root, "jobs");
    if (!jobs || !cJSON_IsArray(jobs) || cJSON_GetArraySize(jobs) == 0) {
        cJSON_Delete(root);
        return;
    }

    cJSON *job_item = cJSON_GetArrayItem(jobs, 0);
    cJSON *doc      = cJSON_GetObjectItem(job_item, "jobDocument");
    if (!doc) { cJSON_Delete(root); return; }

    cJSON *url     = cJSON_GetObjectItem(doc, "url");
    cJSON *version = cJSON_GetObjectItem(doc, "version");
    if (!url || !version) { cJSON_Delete(root); return; }

    if (strcmp(version->valuestring, FIRMWARE_VERSION) == 0) {
        ESP_LOGI(TAG, "Already on v%s", FIRMWARE_VERSION);
        cJSON_Delete(root);
        return;
    }

    ota_job_t *job = calloc(1, sizeof(ota_job_t));
    strncpy(job->url,     url->valuestring,     sizeof(job->url) - 1);
    strncpy(job->version, version->valuestring, sizeof(job->version) - 1);
    cJSON_Delete(root);

    xTaskCreate(ota_task, "ota_task", 8192, job, 5, NULL);
}
