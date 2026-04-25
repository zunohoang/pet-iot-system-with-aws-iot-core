#pragma once
#include <stdbool.h>

/* Start BLE GATT server for provisioning payload transfer. */
bool ble_provisioning_start(void);

/* Stop BLE GATT server. */
void ble_provisioning_stop(void);
