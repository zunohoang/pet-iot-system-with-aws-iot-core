#pragma once
#include <stdbool.h>
#include <stddef.h>

bool provisioning_is_done(void);
bool provisioning_run(void);
bool provisioning_get_thing_name(char *buf, size_t len);
