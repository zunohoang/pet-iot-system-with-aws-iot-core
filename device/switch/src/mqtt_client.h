#pragma once
#include <stdbool.h>

void mqtt_app_start(const char *thing_name);
void mqtt_publish_status(bool relay_on);
