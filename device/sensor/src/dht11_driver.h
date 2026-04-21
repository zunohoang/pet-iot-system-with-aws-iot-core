#pragma once
#include "driver/gpio.h"
#include <stdbool.h>

typedef struct {
    float temperature;  /* Celsius */
    float humidity;     /* % RH */
} dht11_reading_t;

void dht11_init(gpio_num_t gpio);

/*
 * Read DHT11 sensor. Returns true on success and fills *reading.
 * DHT11 requires at least 1 second between consecutive reads.
 */
bool dht11_read(dht11_reading_t *reading);
