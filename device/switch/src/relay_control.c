#include "relay_control.h"
#include "config.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "relay";
static bool s_relay_on = false;

void relay_init(void) {
    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << STATUS_LED_GPIO),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&cfg);

    relay_set(false);
    ESP_LOGI(TAG, "Onboard LED control initialized on GPIO %d", STATUS_LED_GPIO);
}

void relay_set(bool on) {
    s_relay_on = on;
    gpio_set_level(STATUS_LED_GPIO, on ? 1 : 0);
    ESP_LOGI(TAG, "Onboard LED %s", on ? "ON" : "OFF");
}

bool relay_get_state(void) {
    return s_relay_on;
}
