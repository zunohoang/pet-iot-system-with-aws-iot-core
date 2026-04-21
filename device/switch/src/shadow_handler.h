#pragma once
#include "esp_mqtt_client.h"

void shadow_handler_init(esp_mqtt_client_handle_t client, const char *thing_name);
void shadow_report_state(bool relay_on);
void shadow_request_get(void);
