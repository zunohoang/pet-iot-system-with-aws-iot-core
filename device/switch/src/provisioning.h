#pragma once
#include <stdbool.h>
#include <stddef.h>

/* Returns true if the device already has a permanent certificate stored. */
bool provisioning_is_done(void);

/*
 * Store Trusted User claim credentials from the mobile app (or BLE) before
 * WiFi and provisioning_run() — from POST /devices/provisioning-claim.
 */
bool provisioning_set_trusted_user_credentials(const char *cert_pem,
    const char *private_key_pem, const char *iot_data_endpoint_host,
    const char *claim_id);

/* Store WiFi credentials received from app/BLE. */
bool provisioning_set_wifi_credentials(const char *ssid, const char *password);

/* Check whether temporary claim credentials are present in NVS. */
bool provisioning_has_claim_credentials(void);

/* Load WiFi credentials from NVS into buffers. */
bool provisioning_get_wifi_credentials(char *ssid, size_t ssid_len,
    char *password, size_t password_len);

/* Clear temporary Trusted User claim credentials from NVS. */
void provisioning_clear_claim_credentials(void);

/*
 * Fleet Provisioning: loads ephemeral claim from NVS (set above), then
 * CreateKeysAndCertificate + template RegisterThing. On success, clears
 * claim keys and stores the permanent cert/key in NVS.
 */
bool provisioning_run(void);

/* Loads thing_name from NVS into the provided buffer. */
bool provisioning_get_thing_name(char *buf, size_t len);
