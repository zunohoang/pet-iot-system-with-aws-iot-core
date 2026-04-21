#include "config.h"
#include "provisioning.h"
#include "dht11_driver.h"
#include "mqtt_client.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

static const char *TAG = "main";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1
#define WIFI_MAX_RETRY     5

static EventGroupHandle_t s_wifi_events;
static int s_wifi_retry = 0;

static void wifi_event_handler(void *arg, esp_event_base_t base,
                                int32_t event_id, void *event_data) {
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (s_wifi_retry < WIFI_MAX_RETRY) {
            esp_wifi_connect();
            s_wifi_retry++;
        } else {
            xEventGroupSetBits(s_wifi_events, WIFI_FAIL_BIT);
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        s_wifi_retry = 0;
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init(void) {
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t h1, h2;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL, &h1));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL, &h2));

    wifi_config_t wifi_cfg = {
        .sta = {
            .ssid     = WIFI_SSID,
            .password = WIFI_PASSWORD,
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    xEventGroupWaitBits(s_wifi_events,
                        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                        pdFALSE, pdFALSE,
                        pdMS_TO_TICKS(30000));
    ESP_LOGI(TAG, "WiFi ready");
}

/* ── Telemetry task: read DHT11 and publish every TELEMETRY_INTERVAL_MS ─── */
static void telemetry_task(void *arg) {
    dht11_reading_t reading;
    static TickType_t last_read = 0;

    for (;;) {
        /* DHT11 minimum read interval is 1 second */
        TickType_t now = xTaskGetTickCount();
        if ((now - last_read) < pdMS_TO_TICKS(1500)) {
            vTaskDelay(pdMS_TO_TICKS(1500) - (now - last_read));
        }

        if (dht11_read(&reading)) {
            ESP_LOGI(TAG, "T=%.1f°C  H=%.1f%%",
                     reading.temperature, reading.humidity);

            if (reading.temperature > TEMP_HIGH_THRESHOLD) {
                ESP_LOGW(TAG, "High temperature alert: %.1f°C", reading.temperature);
            }
            if (reading.humidity > HUMIDITY_HIGH_THRESHOLD) {
                ESP_LOGW(TAG, "High humidity alert: %.1f%%", reading.humidity);
            }

            mqtt_publish_telemetry(&reading);
        } else {
            ESP_LOGW(TAG, "Failed to read DHT11");
        }

        last_read = xTaskGetTickCount();
        vTaskDelay(pdMS_TO_TICKS(TELEMETRY_INTERVAL_MS));
    }
}

static void status_task(void *arg) {
    for (;;) {
        mqtt_publish_status(true);
        vTaskDelay(pdMS_TO_TICKS(STATUS_INTERVAL_MS));
    }
}

void app_main(void) {
    ESP_LOGI(TAG, "IoT DHT11 Sensor v%s starting", FIRMWARE_VERSION);

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    gpio_set_direction(STATUS_LED_GPIO, GPIO_MODE_OUTPUT);
    dht11_init(DHT11_GPIO);
    wifi_init();

    if (!provisioning_is_done()) {
        ESP_LOGI(TAG, "Running Fleet Provisioning");
        if (!provisioning_run()) {
            ESP_LOGE(TAG, "Provisioning failed");
            for (;;) vTaskDelay(pdMS_TO_TICKS(10000));
        }
        esp_restart();
    }

    char thing_name[64] = {0};
    if (!provisioning_get_thing_name(thing_name, sizeof(thing_name))) {
        ESP_LOGE(TAG, "No thing name in NVS");
        esp_restart();
    }
    ESP_LOGI(TAG, "Thing name: %s", thing_name);

    mqtt_app_start(thing_name);

    xTaskCreate(telemetry_task, "telemetry", 4096, NULL, 5, NULL);
    xTaskCreate(status_task,    "status",    2048, NULL, 3, NULL);

    ESP_LOGI(TAG, "DHT11 sensor running");
}
