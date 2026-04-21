#pragma once
#include <stdbool.h>

void relay_init(void);
void relay_set(bool on);
bool relay_get_state(void);
