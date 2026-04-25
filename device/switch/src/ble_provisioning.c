#include "ble_provisioning.h"
#include "provisioning.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#if defined(CONFIG_BT_NIMBLE_ENABLED) && CONFIG_BT_NIMBLE_ENABLED
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "cJSON.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

static const char *TAG = "ble_prov";

#define BLE_PROV_BUF_SIZE 12288

static char s_dev_name[32];
static uint8_t s_addr_type;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_notify_val_handle;

static char s_payload_buf[BLE_PROV_BUF_SIZE];
static size_t s_payload_len = 0;
static bool s_collecting = false;

static const ble_uuid128_t SERVICE_UUID =
    BLE_UUID128_INIT(0x59, 0x2f, 0xa4, 0x9f, 0xde, 0x4e, 0x2b, 0xaa,
                     0x26, 0x42, 0x50, 0xb9, 0x92, 0xd4, 0xba, 0x91);
static const ble_uuid128_t WRITE_UUID =
    BLE_UUID128_INIT(0x18, 0x9f, 0x80, 0xdd, 0x8f, 0x31, 0x3f, 0xab,
                     0xe3, 0x4b, 0x4c, 0x34, 0x66, 0xd4, 0xa1, 0xcb);
static const ble_uuid128_t NOTIFY_UUID =
    BLE_UUID128_INIT(0x2f, 0x5d, 0xf9, 0xf6, 0x5d, 0x2f, 0x4f, 0x9a,
                     0x34, 0x4f, 0x5f, 0x9f, 0xa5, 0xd1, 0xc5, 0x25);

static void ble_advertise(void);

static void send_ack(const char *msg)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE || s_notify_val_handle == 0) {
        return;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(msg, (uint16_t)strlen(msg));
    if (!om) return;
    ble_gatts_notify_custom(s_conn_handle, s_notify_val_handle, om);
}

static bool process_payload_json(const char *json)
{
    cJSON *root = cJSON_Parse(json);
    if (!root) {
        ESP_LOGE(TAG, "Invalid JSON payload");
        return false;
    }

    cJSON *wifi = cJSON_GetObjectItem(root, "wifi");
    cJSON *iot = cJSON_GetObjectItem(root, "iot");
    const cJSON *ssid = wifi ? cJSON_GetObjectItem(wifi, "ssid") : NULL;
    const cJSON *password = wifi ? cJSON_GetObjectItem(wifi, "password") : NULL;
    const cJSON *cert = iot ? cJSON_GetObjectItem(iot, "certificatePem") : NULL;
    const cJSON *key = iot ? cJSON_GetObjectItem(iot, "privateKey") : NULL;
    const cJSON *host = iot ? cJSON_GetObjectItem(iot, "iotDataEndpoint") : NULL;
    const cJSON *claim = iot ? cJSON_GetObjectItem(iot, "claimId") : NULL;

    bool ok = cJSON_IsString(ssid) && cJSON_IsString(cert) && cJSON_IsString(key)
        && cJSON_IsString(host) && cJSON_IsString(claim);
    if (!ok) {
        ESP_LOGE(TAG, "Missing required fields in BLE payload");
        cJSON_Delete(root);
        return false;
    }

    if (!provisioning_set_wifi_credentials(ssid->valuestring,
        cJSON_IsString(password) ? password->valuestring : "")) {
        cJSON_Delete(root);
        return false;
    }
    if (!provisioning_set_trusted_user_credentials(
        cert->valuestring, key->valuestring, host->valuestring, claim->valuestring)) {
        cJSON_Delete(root);
        return false;
    }

    ESP_LOGI(TAG, "Provisioning payload accepted via BLE (claimId=%s)", claim->valuestring);
    cJSON_Delete(root);
    return true;
}

static int gatt_write_cb(uint16_t conn_handle, uint16_t attr_handle,
    struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)attr_handle;
    (void)arg;
    s_conn_handle = conn_handle;

    char tmp[260] = {0};
    int copy_len = OS_MBUF_PKTLEN(ctxt->om);
    if (copy_len <= 0 || copy_len >= (int)sizeof(tmp)) {
        ESP_LOGE(TAG, "BLE chunk invalid length: %d", copy_len);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    int rc = ble_hs_mbuf_to_flat(ctxt->om, tmp, sizeof(tmp) - 1, NULL);
    if (rc != 0) return BLE_ATT_ERR_UNLIKELY;
    tmp[copy_len] = '\0';

    if (strncmp(tmp, "BEGIN:", 6) == 0) {
        s_payload_len = 0;
        s_collecting = true;
        ESP_LOGI(TAG, "BLE payload BEGIN (%s)", tmp + 6);
        send_ack("ACK:BEGIN");
        return 0;
    }
    if (strcmp(tmp, "END") == 0) {
        if (!s_collecting) {
            send_ack("ERR:NO_BEGIN");
            return 0;
        }
        s_payload_buf[s_payload_len] = '\0';
        ESP_LOGI(TAG, "BLE payload END, total=%u bytes", (unsigned)s_payload_len);
        bool ok = process_payload_json(s_payload_buf);
        s_collecting = false;
        s_payload_len = 0;
        send_ack(ok ? "ACK:OK" : "ERR:PARSE");
        return 0;
    }
    if (!s_collecting) {
        send_ack("ERR:NO_BEGIN");
        return 0;
    }

    if (s_payload_len + (size_t)copy_len >= BLE_PROV_BUF_SIZE - 1) {
        ESP_LOGE(TAG, "BLE payload too large");
        s_collecting = false;
        s_payload_len = 0;
        send_ack("ERR:TOO_LARGE");
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    memcpy(s_payload_buf + s_payload_len, tmp, (size_t)copy_len);
    s_payload_len += (size_t)copy_len;
    return 0;
}

static int gatt_notify_cb(uint16_t conn_handle, uint16_t attr_handle,
    struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)ctxt;
    (void)arg;
    return 0;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SERVICE_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &WRITE_UUID.u,
                .access_cb = gatt_write_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = &NOTIFY_UUID.u,
                .access_cb = gatt_notify_cb,
                .flags = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &s_notify_val_handle,
            },
            { 0 }
        }
    },
    { 0 }
};

static int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                s_conn_handle = event->connect.conn_handle;
                ESP_LOGI(TAG, "BLE connected (handle=%u)", s_conn_handle);
            } else {
                ESP_LOGW(TAG, "BLE connect failed: status=%d", event->connect.status);
                ble_advertise();
            }
            return 0;
        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGW(TAG, "BLE disconnected: reason=%d", event->disconnect.reason);
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            ble_advertise();
            return 0;
        case BLE_GAP_EVENT_SUBSCRIBE:
            ESP_LOGI(TAG, "BLE subscribe event");
            return 0;
        default:
            return 0;
    }
}

static void ble_advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (const uint8_t *)s_dev_name;
    fields.name_len = (uint8_t)strlen(s_dev_name);
    fields.name_is_complete = 1;
    fields.uuids128 = (ble_uuid128_t *)&SERVICE_UUID;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;

    ble_gap_adv_set_fields(&fields);

    struct ble_gap_adv_params adv_params = {0};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event_cb, NULL);
    ESP_LOGI(TAG, "BLE advertising as %s", s_dev_name);
}

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &s_addr_type);
    ble_advertise();
}

static void ble_host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

bool ble_provisioning_start(void)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_dev_name, sizeof(s_dev_name), "IOT-PROV-%02X%02X%02X",
        mac[3], mac[4], mac[5]);

    ESP_LOGI(TAG, "BLE start: free heap=%u", (unsigned)esp_get_free_heap_size());
    int rc = nimble_port_init();
    if (rc != 0) {
        ESP_LOGE(TAG, "nimble_port_init failed: rc=%d", rc);
        return false;
    }

    ble_svc_gap_init();
    ble_svc_gatt_init();
    rc = ble_svc_gap_device_name_set(s_dev_name);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_svc_gap_device_name_set failed: rc=%d", rc);
        return false;
    }
    rc = ble_gatts_count_cfg(gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_count_cfg failed: rc=%d", rc);
        return false;
    }
    rc = ble_gatts_add_svcs(gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_add_svcs failed: rc=%d", rc);
        return false;
    }
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(ble_host_task);
    ESP_LOGI(TAG, "BLE provisioning server started");
    return true;
}

void ble_provisioning_stop(void)
{
    ESP_LOGI(TAG, "BLE provisioning stop requested");
}

#else

static const char *TAG = "ble_prov";

bool ble_provisioning_start(void)
{
    ESP_LOGE(TAG, "NimBLE is disabled in sdkconfig. Enable CONFIG_BT_NIMBLE_ENABLED.");
    return false;
}

void ble_provisioning_stop(void)
{
    ESP_LOGW(TAG, "BLE provisioning stop ignored (NimBLE disabled)");
}

#endif
