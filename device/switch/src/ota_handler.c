#include "ota_handler.h"
#include "config.h"
#include "esp_log.h"
#include "esp_https_ota.h"
#include "esp_ota_ops.h"
#include "esp_http_client.h"
#include "cJSON.h"
#include "mbedtls/sha256.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <stdlib.h>

static const char *TAG = "ota";

extern const uint8_t root_ca_pem_start[] asm("_binary_root_ca_pem_start");

typedef struct {
    char url[512];
    char version[32];
    char checksum[65];  /* SHA256 hex */
    char job_id[128];
} ota_job_t;

static void ota_task(void *arg) {
    ota_job_t *job = (ota_job_t *)arg;
    ESP_LOGI(TAG, "Starting OTA update to version %s", job->version);
    ESP_LOGI(TAG, "URL: %s", job->url);

    esp_http_client_config_t http_cfg = {
        .url             = job->url,
        .cert_pem        = (const char *)root_ca_pem_start,
        .keep_alive_enable = true,
        .timeout_ms      = 30000,
    };

    esp_https_ota_config_t ota_cfg = {
        .http_config = &http_cfg,
    };

    esp_err_t ret = esp_https_ota(&ota_cfg);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "OTA succeeded — restarting");
        free(job);
        esp_restart();
    } else {
        ESP_LOGE(TAG, "OTA failed: %s", esp_err_to_name(ret));
        free(job);
    }

    vTaskDelete(NULL);
}

void ota_handle_job_notification(const char *data, int data_len) {
    char buf[2048] = {0};
    snprintf(buf, sizeof(buf), "%.*s", data_len, data);

    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        ESP_LOGE(TAG, "Invalid OTA job JSON");
        return;
    }

    /* Navigate: jobs[0].jobDocument */
    cJSON *jobs = cJSON_GetObjectItem(root, "jobs");
    if (!jobs || !cJSON_IsArray(jobs) || cJSON_GetArraySize(jobs) == 0) {
        cJSON_Delete(root);
        return;
    }

    cJSON *job_item = cJSON_GetArrayItem(jobs, 0);
    cJSON *doc      = cJSON_GetObjectItem(job_item, "jobDocument");
    cJSON *job_id   = cJSON_GetObjectItem(job_item, "jobId");

    if (!doc || !job_id) {
        cJSON_Delete(root);
        return;
    }

    cJSON *url      = cJSON_GetObjectItem(doc, "url");
    cJSON *version  = cJSON_GetObjectItem(doc, "version");
    cJSON *checksum = cJSON_GetObjectItem(doc, "checksum");

    if (!url || !version) {
        ESP_LOGE(TAG, "OTA job document missing url or version");
        cJSON_Delete(root);
        return;
    }

    /* Compare versions to avoid re-flashing same firmware */
    if (strcmp(version->valuestring, FIRMWARE_VERSION) == 0) {
        ESP_LOGI(TAG, "Already on version %s, skipping OTA", FIRMWARE_VERSION);
        cJSON_Delete(root);
        return;
    }

    ota_job_t *job = calloc(1, sizeof(ota_job_t));
    strncpy(job->url,     url->valuestring,     sizeof(job->url) - 1);
    strncpy(job->version, version->valuestring, sizeof(job->version) - 1);
    strncpy(job->job_id,  job_id->valuestring,  sizeof(job->job_id) - 1);
    if (checksum) {
        strncpy(job->checksum, checksum->valuestring, sizeof(job->checksum) - 1);
    }

    cJSON_Delete(root);

    /* Run OTA in a dedicated task to avoid blocking MQTT event loop */
    xTaskCreate(ota_task, "ota_task", 8192, job, 5, NULL);
}
