# Luồng 06: Rule Engine & Smart Scene Automation

> **Mô tả:** Luồng tự động hóa thông minh (Smart Scene) kết hợp IoT Rule Engine, Scene Engine Lambda, và Device Shadow. Hỗ trợ 3 loại trigger: lịch (EventBridge), ngưỡng cảm biến (IoT Rule), và thủ công từ app.

---

## Tổng Quan Luồng

```
TRIGGER SOURCES:
1. EventBridge Schedule: cron(0 15 * * ? *) → NightMode @ 22:00 UTC+7
2. IoT Rule Engine: high_temp_alert (temp>35 OR hum>80) → Lambda → SceneEngine
3. Mobile App: POST /scenes/{sceneId}/run → Lambda → SceneEngine

SCENE ENGINE FLOW:
→ Lambda: scene-engine
→ Query DynamoDB scenes table (filter by enabled + triggerType)
→ applyAction(deviceId, state)
→ IoT Data Plane: UpdateThingShadow { state:{ desired: state } }
→ AWS IoT Core: push delta → Device
→ Device: shadow_process_delta() → relay_set() → shadow_report_state()
```

---

## Sequence Diagram

```mermaid
sequenceDiagram
    participant EventBridge as ⏰ EventBridge<br/>cron(0 15 * * ? *)
    participant IoTRule as 📋 IoT Rule Engine<br/>(high_temp_alert)
    participant App as 📱 Mobile App<br/>(SceneScreen)
    participant APIGW as 🌐 API Gateway
    participant LambdaAPI as ⚡ Lambda: api
    participant LambdaScene as ⚡ Lambda:<br/>scene-engine
    participant DDB_Scenes as 🗄️ DynamoDB:<br/>scenes
    participant IoTData as ☁️ IoT Data Plane<br/>(UpdateThingShadow)
    participant IoTCore as ☁️ AWS IoT Core<br/>(MQTT Broker)
    participant Device as 🔌 ESP32 Switch<br/>(shadow_handler.c)

    Note over EventBridge,Device: ═══ SETUP: Tạo Scene mới từ Mobile App ═══

    App->>APIGW: POST /scenes  [JWT Bearer]<br/>{ name:"Night Mode",<br/>  trigger:{ type:"schedule", scheduleName:"NightMode" },<br/>  actions:[{ deviceId:"switch-xxx",<br/>              state:{ relay:"ON" } }],<br/>  enabled: true }
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>DDB_Scenes: PutItem { userId, sceneId:uuid(),<br/>  name, trigger, actions,<br/>  enabled:"true", createdAt }
    DDB_Scenes-->>LambdaAPI: OK
    LambdaAPI-->>App: 201 { sceneId, name, ... }

    Note over EventBridge,Device: ═══ TRIGGER 1: EventBridge Schedule (22:00 UTC+7) ═══

    EventBridge->>LambdaScene: invoke (scheduled)<br/>{ source:"eventbridge-scheduler",<br/>  triggerType:"schedule",<br/>  scheduleName:"NightMode" }
    LambdaScene->>DDB_Scenes: Scan<br/>FilterExpression: enabled='true'<br/>AND trigger.type='schedule'
    DDB_Scenes-->>LambdaScene: [{ sceneId, name:"Night Mode",<br/>  trigger:{type:"schedule", scheduleName:"NightMode"},<br/>  actions:[{ deviceId:"switch-xxx", state:{relay:"ON"} }] }]
    LambdaScene->>LambdaScene: Filter: scheduleName === "NightMode"
    LambdaScene->>IoTData: UpdateThingShadow("switch-xxx")<br/>{ state:{ desired:{ relay:"ON" } } }
    IoTData-->>LambdaScene: OK
    LambdaScene-->>EventBridge: { executed: 1 }

    IoTCore->>Device: MQTT PUBLISH: shadow/update/delta<br/>{ state:{ relay:"ON" } }
    Device->>Device: shadow_process_delta() → relay_set(true)
    Device->>IoTCore: PUBLISH: shadow/update { reported:{ relay:"ON" } }

    Note over EventBridge,Device: ═══ TRIGGER 2: IoT Rule Engine (Threshold Alert) ═══

    rect rgb(255, 240, 240)
        Note over IoTRule,Device: Sensor phát hiện nhiệt độ > 35°C
        IoTRule->>LambdaScene: invoke (from iot-processor invocation)<br/>{ alertType:"threshold",<br/>  deviceId:"sensor-yyy",<br/>  temperature:36.5 }
        LambdaScene->>DDB_Scenes: Scan<br/>FilterExpression: enabled='true'<br/>AND trigger.type='threshold'
        DDB_Scenes-->>LambdaScene: [{ sceneId, trigger:{type:"threshold",<br/>  deviceId:"*"},<br/>  actions:[{ deviceId:"switch-xxx",<br/>              state:{relay:"OFF"} }] }]
        LambdaScene->>LambdaScene: Filter: trigger.deviceId === "sensor-yyy"<br/>OR trigger.deviceId === "*"
        LambdaScene->>IoTData: UpdateThingShadow("switch-xxx")<br/>{ state:{ desired:{ relay:"OFF" } } }
        IoTCore->>Device: MQTT: delta { relay:"OFF" }
        Device->>Device: relay_set(false)
    end

    Note over EventBridge,Device: ═══ TRIGGER 3: Thủ công từ Mobile App ═══

    App->>APIGW: POST /scenes/{sceneId}/run  [JWT Bearer]
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>LambdaAPI: require('../ota-manager/handler')<br/>→ InvokeLambda("scene-engine")<br/>Payload: { userId, sceneId }
    LambdaAPI-->>App: 200 { message:"Scene triggered" }

    LambdaScene->>DDB_Scenes: Query<br/>KeyCondition: userId=:uid AND sceneId=:sid
    DDB_Scenes-->>LambdaScene: scene object
    LambdaScene->>IoTData: UpdateThingShadow (for each action)
    IoTCore->>Device: MQTT: delta
    Device->>Device: shadow_process_delta() → act

    Note over EventBridge,Device: ═══ SCENE MANAGEMENT (CRUD) ═══

    App->>APIGW: GET /scenes
    LambdaAPI->>DDB_Scenes: Query(userId)
    DDB_Scenes-->>App: [list of scenes]

    App->>APIGW: PUT /scenes/{sceneId}<br/>{ enabled: false }
    LambdaAPI->>DDB_Scenes: UpdateItem SET enabled="false"
    DDB_Scenes-->>App: { message:"Scene updated" }

    App->>APIGW: DELETE /scenes/{sceneId}
    LambdaAPI->>DDB_Scenes: DeleteItem
    DDB_Scenes-->>App: { message:"Scene deleted" }
```

---

## Scene Data Model

```json
// DynamoDB: scenes table
{
  "userId":    "cognito-sub-uuid",
  "sceneId":   "550e8400-e29b-41d4-a716-446655440000",
  "name":      "Night Mode",
  "trigger": {
    "type":         "schedule",
    "scheduleName": "NightMode"
  },
  "actions": [
    {
      "deviceId": "switch-C3F9A...",
      "state": {
        "relay": "ON"
      }
    }
  ],
  "enabled":   "true",
  "createdAt": "2024-04-24T14:00:00.000Z"
}
```

---

## Loại Trigger Hỗ Trợ

| Trigger Type | Nguồn | Condition | Ví dụ |
|-------------|-------|-----------|-------|
| `schedule` | EventBridge cron | `scheduleName` match | NightMode: bật đèn lúc 22:00 |
| `threshold` | IoT Rule → iot-processor → scene-engine | `deviceId` match (or `*`) | Nhiệt độ > 35°C → tắt relay |
| `direct` | POST /scenes/{id}/run | sceneId + userId | User nhấn "Run Now" |

---

## IoT Rule Engine SQL (Liên quan Scene)

```sql
-- Rule: high_temp_alert → Lambda iot-processor
-- (iot-processor có thể invoke scene-engine cho threshold scenes)
SELECT *, topic(2) as deviceId
FROM 'devices/+/telemetry'
WHERE temperature > 35 OR humidity > 80
-- Action: invoke Lambda iot-processor
-- iot-processor → (tùy implementation) invoke scene-engine với alertType:"threshold"
```

---

## EventBridge Rule

```hcl
# Nightly scene @ 22:00 UTC+7 = 15:00 UTC
aws_cloudwatch_event_rule:
  schedule_expression: "cron(0 15 * * ? *)"

# Input payload gửi vào Lambda scene-engine:
{
  "source":       "eventbridge-scheduler",
  "triggerType":  "schedule",
  "scheduleName": "NightMode"
}
```

---

## API Endpoints (Scene CRUD)

```http
GET    /scenes                    → List tất cả scenes của user
POST   /scenes                    → Tạo scene mới
PUT    /scenes/{sceneId}          → Cập nhật scene (name, trigger, actions, enabled)
DELETE /scenes/{sceneId}          → Xóa scene
POST   /scenes/{sceneId}/run      → Chạy scene ngay lập tức
```

---

## Source Code References

| File | Vai trò |
|------|---------|
| `backend/functions/scene-engine/handler.js` | Core: getScenesForTrigger(), executeScene(), applyAction() |
| `backend/functions/api/handler.js` | listScenes(), createScene(), updateScene(), deleteScene(), runScene() |
| `infra/modules/processing/lambda.tf` | EventBridge rule → scene-engine, aws_cloudwatch_event_target |
| `infra/modules/data/dynamodb.tf` | scenes table (userId PK, sceneId SK, enabled GSI) |
| `device/switch/src/shadow_handler.c` | shadow_process_delta() nhận desired state |
| `mobile/src/screens/SceneScreen.jsx` | UI tạo, liệt kê, bật/tắt, chạy scenes |
| `mobile/src/services/api.js` | listScenes(), createScene(), runScene() |
