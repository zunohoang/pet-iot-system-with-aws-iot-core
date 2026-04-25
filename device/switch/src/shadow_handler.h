#pragma once
#include <mqtt_client.h>
#include <stdbool.h>

void shadow_handler_init(esp_mqtt_client_handle_t client, const char *thing_name);
void shadow_report_state(bool relay_on);
void shadow_request_get(void);
void shadow_process_delta(const char *payload, int len);
