#include "config.h"
#include "provisioning.h"
#include "ble_provisioning.h"
#include "relay_control.h"
#include "iot_mqtt_client.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include <string.h>

static const char *TAG = "main";

#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1
#define WIFI_MAX_RETRY      5

static EventGroupHandle_t s_wifi_events;
static int s_wifi_retry = 0;
static bool s_wifi_started = false;

/* ── WiFi event handler ──────────────────────────────────────────────── */
static void wifi_event_handler(void *arg, esp_event_base_t base,
                                int32_t event_id, void *event_data) {
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_wifi_retry < WIFI_MAX_RETRY) {
            esp_wifi_connect();
            s_wifi_retry++;
            ESP_LOGW(TAG, "WiFi retry %d/%d", s_wifi_retry, WIFI_MAX_RETRY);
        } else {
            xEventGroupSetBits(s_wifi_events, WIFI_FAIL_BIT);
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *evt = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&evt->ip_info.ip));
        s_wifi_retry = 0;
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init(void) {
    if (s_wifi_started) {
        ESP_LOGI(TAG, "WiFi already initialized");
        return;
    }
    s_wifi_events = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t h1, h2;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &h1));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &h2));

    char wifi_ssid[33] = {0};
    char wifi_pass[65] = {0};
    bool has_wifi = provisioning_get_wifi_credentials(
        wifi_ssid, sizeof(wifi_ssid), wifi_pass, sizeof(wifi_pass));
    if (!has_wifi) {
        strncpy(wifi_ssid, WIFI_SSID, sizeof(wifi_ssid) - 1);
        strncpy(wifi_pass, WIFI_PASSWORD, sizeof(wifi_pass) - 1);
        ESP_LOGW(TAG, "WiFi credentials not found in NVS, fallback to config.h");
    } else {
        ESP_LOGI(TAG, "Loaded WiFi credentials from NVS (SSID length=%u)", (unsigned)strlen(wifi_ssid));
    }

    wifi_config_t wifi_cfg = {0};
    strncpy((char *)wifi_cfg.sta.ssid, wifi_ssid, sizeof(wifi_cfg.sta.ssid) - 1);
    strncpy((char *)wifi_cfg.sta.password, wifi_pass, sizeof(wifi_cfg.sta.password) - 1);
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    s_wifi_started = true;

    EventBits_t bits = xEventGroupWaitBits(s_wifi_events,
                                           WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(30000));
    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Connected to WiFi");
    } else {
        ESP_LOGE(TAG, "Failed to connect to WiFi");
    }
}

static void wifi_stop(void) {
    if (!s_wifi_started) return;
    esp_err_t err = esp_wifi_stop();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_stop returned: %s", esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "WiFi stopped to save power");
    }
    s_wifi_started = false;
}

/* ── Periodic status publisher ───────────────────────────────────────── */
static void status_task(void *arg) {
    for (;;) {
        mqtt_publish_status(relay_get_state());
        vTaskDelay(pdMS_TO_TICKS(STATUS_PUBLISH_INTERVAL_MS));
    }
}

/* ── Application entry point ─────────────────────────────────────────── */
void app_main(void) {
    ESP_LOGI(TAG, "IoT Light Switch v%s starting", FIRMWARE_VERSION);

    /* Init NVS */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    relay_init();

    /* Fleet Provisioning: run only on first boot */
    if (!provisioning_is_done()) {
        if (!provisioning_has_claim_credentials()) {
            ESP_LOGW(TAG, "No claim credentials yet. Starting BLE provisioning server and waiting for app setup payload...");
            if (!ble_provisioning_start()) {
                ESP_LOGE(TAG, "Failed to start BLE provisioning server");
                for (;;) vTaskDelay(pdMS_TO_TICKS(2000));
            }
            while (!provisioning_has_claim_credentials()) {
                ESP_LOGI(TAG, "Waiting for BLE provisioning payload (WiFi + cert + key + claimId)...");
                vTaskDelay(pdMS_TO_TICKS(5000));
            }
            ESP_LOGI(TAG, "Received claim credentials from BLE payload");
            esp_restart();
        }

        ESP_LOGI(TAG, "Claim credentials available. Enabling WiFi for Fleet Provisioning...");
        wifi_init();
        ESP_LOGI(TAG, "First boot — running Fleet Provisioning");
        if (!provisioning_run()) {
            ESP_LOGE(TAG, "Provisioning failed. Clearing temporary claim and rebooting to BLE wait mode...");
            provisioning_clear_claim_credentials();
            wifi_stop();
            vTaskDelay(pdMS_TO_TICKS(1000));
            esp_restart();
        }
        ESP_LOGI(TAG, "Provisioning complete — restarting");
        esp_restart();
    }

    ESP_LOGI(TAG, "Device already provisioned. Enabling WiFi + MQTT runtime...");
    wifi_init();

    /* Load permanent thing name and start MQTT */
    char thing_name[64] = {0};
    if (!provisioning_get_thing_name(thing_name, sizeof(thing_name))) {
        ESP_LOGE(TAG, "Failed to load thing name from NVS");
        esp_restart();
    }
    ESP_LOGI(TAG, "Thing name: %s", thing_name);

    mqtt_app_start(thing_name);

    xTaskCreate(status_task, "status_task", 4096, NULL, 3, NULL);

    ESP_LOGI(TAG, "System running");
}
