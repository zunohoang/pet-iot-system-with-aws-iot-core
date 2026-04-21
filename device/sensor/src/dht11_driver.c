#include "dht11_driver.h"
#include "esp_log.h"
#include "rom/ets_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdint.h>

static const char *TAG = "dht11";
static gpio_num_t s_gpio;

void dht11_init(gpio_num_t gpio) {
    s_gpio = gpio;
    gpio_set_direction(gpio, GPIO_MODE_OUTPUT);
    gpio_set_level(gpio, 1);
    ESP_LOGI(TAG, "DHT11 initialized on GPIO %d", gpio);
}

/*
 * DHT11 single-bus protocol:
 * 1. Host pulls LOW for 18ms, then HIGH for 20-40µs (start signal)
 * 2. Sensor pulls LOW 80µs, then HIGH 80µs (acknowledge)
 * 3. 40 bits transmitted: 8 humidity int, 8 humidity dec (always 0),
 *    8 temperature int, 8 temperature dec (always 0), 8 checksum
 */
bool dht11_read(dht11_reading_t *reading) {
    uint8_t data[5] = {0};

    /* Send start signal */
    gpio_set_direction(s_gpio, GPIO_MODE_OUTPUT);
    gpio_set_level(s_gpio, 0);
    vTaskDelay(pdMS_TO_TICKS(20));   /* pull low ≥ 18ms */
    gpio_set_level(s_gpio, 1);
    ets_delay_us(30);

    /* Switch to input and wait for sensor response */
    gpio_set_direction(s_gpio, GPIO_MODE_INPUT);

    /* Wait for sensor to pull low (response signal) */
    int timeout = 80;
    while (gpio_get_level(s_gpio) == 1) {
        ets_delay_us(1);
        if (--timeout == 0) {
            ESP_LOGW(TAG, "Timeout waiting for DHT11 response (1)");
            return false;
        }
    }

    /* Wait for sensor to pull high */
    timeout = 80;
    while (gpio_get_level(s_gpio) == 0) {
        ets_delay_us(1);
        if (--timeout == 0) {
            ESP_LOGW(TAG, "Timeout waiting for DHT11 response (2)");
            return false;
        }
    }

    /* Wait for sensor to pull low again (start of data) */
    timeout = 80;
    while (gpio_get_level(s_gpio) == 1) {
        ets_delay_us(1);
        if (--timeout == 0) {
            ESP_LOGW(TAG, "Timeout waiting for data start");
            return false;
        }
    }

    /* Read 40 bits */
    for (int i = 0; i < 40; i++) {
        /* Each bit starts with 50µs low pulse */
        timeout = 60;
        while (gpio_get_level(s_gpio) == 0) {
            ets_delay_us(1);
            if (--timeout == 0) break;
        }

        /* Bit duration: ~26µs = '0', ~70µs = '1' */
        ets_delay_us(35);
        int bit = gpio_get_level(s_gpio);
        data[i / 8] = (data[i / 8] << 1) | bit;

        /* Wait for bit high to end */
        timeout = 80;
        while (gpio_get_level(s_gpio) == 1) {
            ets_delay_us(1);
            if (--timeout == 0) break;
        }
    }

    /* Restore output high */
    gpio_set_direction(s_gpio, GPIO_MODE_OUTPUT);
    gpio_set_level(s_gpio, 1);

    /* Verify checksum */
    uint8_t checksum = data[0] + data[1] + data[2] + data[3];
    if (checksum != data[4]) {
        ESP_LOGW(TAG, "DHT11 checksum error: calc=%02x recv=%02x", checksum, data[4]);
        return false;
    }

    reading->humidity    = (float)data[0] + (float)data[1] * 0.1f;
    reading->temperature = (float)data[2] + (float)data[3] * 0.1f;

    ESP_LOGD(TAG, "DHT11: %.1f°C  %.1f%%RH",
             reading->temperature, reading->humidity);
    return true;
}
