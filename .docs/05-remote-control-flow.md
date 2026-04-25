# Luồng 05: Remote Device Control (Shared Attributes / IoT Shadow)

> **Mô tả:** Luồng điều khiển thiết bị từ xa thông qua AWS IoT Device Shadow. Mobile App gửi lệnh (ví dụ: bật/tắt relay) → API Gateway → Lambda → Shadow "desired" → IoT Core delta → ESP32 Device phản hồi relay và báo lại "reported".

---

## Tổng Quan Luồng

```
[Mobile App] → POST /devices/{id}/shadow { relay:"ON" }
→ API Gateway (JWT auth) → Lambda: api
→ IoT Data Plane: UpdateThingShadow { state:{ desired:{ relay:"ON" } } }
→ AWS IoT Core: tính delta (desired ≠ reported)
→ MQTT PUBLISH: $aws/things/{id}/shadow/update/delta { state:{ relay:"ON" } }
→ ESP32 Switch: shadow_process_delta() → relay_set(true)
→ ESP32 Switch: shadow_report_state() → PUBLISH shadow/update { state:{ reported:{ relay:"ON" } } }
→ IoT Core: delta resolved (desired = reported)
```

---

## Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant App as 📱 Mobile App<br/>(DeviceControlScreen)
    participant APIGW as 🌐 API Gateway
    participant LambdaAPI as ⚡ Lambda: api
    participant DDB_UserDev as 🗄️ DynamoDB<br/>user-device
    participant IoTData as ☁️ IoT Data Plane<br/>(GetThingShadow /<br/>UpdateThingShadow)
    participant IoTCore as ☁️ AWS IoT Core<br/>(MQTT Broker)
    participant Device as 🔌 ESP32 Switch<br/>(shadow_handler.c)
    participant Relay as ⚡ Relay<br/>(GPIO)

    Note over User,Relay: ═══ PHASE 1: Mobile App lấy trạng thái hiện tại ═══

    User->>App: Mở DeviceControlScreen
    App->>APIGW: GET /devices/{deviceId}  [JWT Bearer]
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>DDB_UserDev: GetItem(userId, deviceId) → ownership check
    LambdaAPI->>IoTData: GetThingShadow(thingName: deviceId)
    IoTData-->>LambdaAPI: { state:{ reported:{ relay:"OFF",<br/>  firmwareVersion:"1.0.0", deviceType:"switch" },<br/>  desired:{ relay:"OFF" },<br/>  delta:{} }, metadata, version, timestamp }
    LambdaAPI-->>App: 200 { ...deviceInfo, shadow:{ reported, desired } }
    App->>App: Render switch UI<br/>relay = "OFF" → Toggle = OFF

    Note over User,Relay: ═══ PHASE 2: User gửi lệnh điều khiển ═══

    User->>App: Toggle switch → ON
    App->>APIGW: POST /devices/{deviceId}/shadow<br/>{ relay: "ON" }  [JWT Bearer]
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>DDB_UserDev: GetItem(userId, deviceId) → ownership check ✅
    LambdaAPI->>IoTData: UpdateThingShadow(thingName: deviceId)<br/>{ state:{ desired:{ relay:"ON" } } }
    IoTData-->>LambdaAPI: { version: 5 } ✅
    LambdaAPI-->>App: 200 { message:"Shadow updated", desired:{ relay:"ON" } }
    App->>App: Update UI optimistically<br/>Toggle = ON (pending)

    Note over User,Relay: ═══ PHASE 3: AWS IoT Core tính delta và push xuống device ═══

    IoTData->>IoTCore: Shadow tính delta:<br/>desired.relay = "ON" ≠ reported.relay = "OFF"
    IoTCore->>Device: MQTT PUBLISH QoS1:<br/>$aws/things/{deviceId}/shadow/update/delta<br/>{ state:{ relay:"ON" }, metadata:{...}, version:5 }

    Note over User,Relay: ═══ PHASE 4: Device xử lý delta và điều khiển relay ═══

    Device->>Device: mqtt_event_handler() MQTT_EVENT_DATA<br/>topic contains "shadow/update/delta"<br/>→ shadow_process_delta(payload)
    Device->>Device: cJSON_Parse(payload)<br/>state.relay = "ON" → turn_on = true
    Device->>Relay: relay_set(true) → GPIO_SET_LEVEL HIGH
    Relay-->>Device: Relay ON ✅

    Note over User,Relay: ═══ PHASE 5: Device báo lại trạng thái (reported) ═══

    Device->>Device: shadow_report_state(relay_on=true)
    Device->>IoTCore: MQTT PUBLISH QoS1:<br/>$aws/things/{deviceId}/shadow/update<br/>{ state:{ reported:{ relay:"ON",<br/>  firmwareVersion:"1.0.0", deviceType:"switch" } } }
    IoTCore->>IoTCore: Delta resolved:<br/>desired.relay = "ON" = reported.relay = "ON"<br/>Delta = {} (empty)

    Note over User,Relay: ═══ PHASE 6: Mobile App polling trạng thái (optional) ═══

    App->>APIGW: GET /devices/{deviceId}
    LambdaAPI->>IoTData: GetThingShadow
    IoTData-->>LambdaAPI: { reported:{ relay:"ON" }, desired:{ relay:"ON" }, delta:{} }
    LambdaAPI-->>App: shadow.reported.relay = "ON"
    App->>App: Confirm Toggle = ON ✅

    Note over User,Relay: ═══ SCENARIO: Device offline khi nhận lệnh ═══

    rect rgb(255, 240, 240)
        Note over IoTData,Device: Device offline
        LambdaAPI->>IoTData: UpdateThingShadow desired:{ relay:"OFF" }
        IoTData-->>LambdaAPI: OK (shadow stored)
        Note over IoTData: Shadow persistent<br/>delta tồn tại đến khi device online
        Device->>IoTCore: MQTT Connect (reconnect)
        Device->>IoTCore: SUBSCRIBE: $aws/things/{id}/shadow/update/delta
        IoTCore->>Device: MQTT PUBLISH: delta { relay:"OFF" }
        Device->>Device: shadow_process_delta() → relay_set(false)
        Device->>IoTCore: PUBLISH: reported { relay:"OFF" }
    end
```

---

## Shadow Document Structure

```json
// Trạng thái Shadow đầy đủ (GET /devices/{id})
{
  "state": {
    "desired": {
      "relay": "ON"
    },
    "reported": {
      "relay": "ON",
      "firmwareVersion": "1.0.0",
      "deviceType": "switch"
    },
    "delta": {}
  },
  "metadata": {
    "desired": { "relay": { "timestamp": 1714000100 } },
    "reported": { "relay": { "timestamp": 1714000105 } }
  },
  "version": 5,
  "timestamp": 1714000105
}
```

```json
// Delta message khi relay muốn = ON nhưng reported = OFF
{
  "state": {
    "relay": "ON"
  },
  "metadata": {
    "relay": { "timestamp": 1714000100 }
  },
  "version": 5
}
```

---

## MQTT Topics for Shadow

| Topic | QoS | Hướng | Mô tả |
|-------|-----|-------|-------|
| `$aws/things/{id}/shadow/update` | 1 | Device→Cloud | Device publish desired hoặc reported |
| `$aws/things/{id}/shadow/update/accepted` | 1 | Cloud→Device | Shadow update thành công |
| `$aws/things/{id}/shadow/update/rejected` | 1 | Cloud→Device | Shadow update thất bại |
| `$aws/things/{id}/shadow/update/delta` | 1 | Cloud→Device | **Delta: desired ≠ reported** |
| `$aws/things/{id}/shadow/get` | 1 | Device→Cloud | Device yêu cầu shadow hiện tại |
| `$aws/things/{id}/shadow/get/accepted` | 1 | Cloud→Device | Shadow state trả về |

---

## Sensor vs Switch Shadow

| Thiết bị | reported fields | desired fields | delta action |
|----------|----------------|----------------|--------------|
| **Sensor** | temperature, humidity, firmwareVersion, deviceType | (alarm thresholds - future) | Log only (not implemented) |
| **Switch** | relay ("ON"/"OFF"), firmwareVersion, deviceType | relay ("ON"/"OFF") | `relay_set()` → GPIO → `shadow_report_state()` |

---

## API Endpoints

```http
GET /devices/{deviceId}
Authorization: Bearer {Cognito JWT}
→ Returns: { shadow: { state, metadata, version } }

POST /devices/{deviceId}/shadow
Authorization: Bearer {Cognito JWT}
Content-Type: application/json
Body: { "relay": "ON" }
→ UpdateThingShadow: { state: { desired: { relay: "ON" } } }
→ Returns: { message: "Shadow updated", desired: { relay: "ON" } }
```

---

## Source Code References

| File | Vai trò |
|------|---------|
| `device/switch/src/shadow_handler.c` | `shadow_process_delta()` → `relay_set()` → `shadow_report_state()` |
| `device/switch/src/mqtt_client.c` | Subscribe delta, route sang shadow_handler |
| `device/switch/src/relay_control.c` | `relay_set()` GPIO control |
| `device/sensor/src/shadow_handler.c` | `shadow_report_state()` (sensor chỉ report, không control) |
| `device/sensor/src/shadow_handler.h` | `shadow_process_delta()` (no-op for sensor) |
| `backend/functions/api/handler.js` | `getDevice()`, `updateShadow()` |
| `mobile/src/screens/DeviceControlScreen.jsx` | UI toggle, call `updateDeviceShadow()` |
| `mobile/src/services/api.js` | `updateDeviceShadow(id, state)` |
| `infra/modules/iot/iot_core.tf` | IoT Policy: Allow iot:Publish shadow/update, Subscribe shadow/* |
