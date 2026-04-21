#pragma once
#include "dht11_driver.h"

void mqtt_app_start(const char *thing_name);
void mqtt_publish_telemetry(const dht11_reading_t *reading);
void mqtt_publish_status(bool online);
