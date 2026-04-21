#pragma once
#include <stdbool.h>

/* Returns true if the device already has a permanent certificate stored. */
bool provisioning_is_done(void);

/*
 * Runs the Fleet Provisioning flow using the pre-flashed claim certificate.
 * On success, stores the permanent cert/key in NVS and sets thing_name.
 * Returns true on success.
 */
bool provisioning_run(void);

/* Loads thing_name from NVS into the provided buffer. */
bool provisioning_get_thing_name(char *buf, size_t len);
