# Luồng 04: Data Collection & Real-time Monitoring (MQTT)

> **Mô tả:** Luồng thu thập dữ liệu telemetry từ cảm biến DHT11 (nhiệt độ/độ ẩm) và luồng monitoring real-time từ mobile app. Bao gồm cả MQTT publish, IoT Rule Engine, InfluxDB time-series, DynamoDB status, và SNS alerts.

---

## Tổng Quan Luồng

```
[DHT11] → [ESP32 Sensor] → MQTT publish →[AWS IoT Core]
                                         → Rule: process_all_telemetry → Lambda IoT Processor
                                                                        → InfluxDB (time-series)
                                                                        → DynamoDB (lastSeen)
                                         → Rule: high_temp_alert (temp>35 OR hum>80)
                                                                        → Lambda IoT Processor
                                                                        → SNS email alert
                                         → Rule: device_status → DynamoDB
[Mobile App] → GET /devices/{id}/telemetry → InfluxDB InfluxQL query → Response
```

---

## Sequence Diagram

```mermaid
sequenceDiagram
    participant DHT11 as 🌡️ DHT11 Sensor<br/>(GPIO 4)
    participant ESP32 as 🔌 ESP32<br/>(FreeRTOS Tasks)
    participant IoTCore as ☁️ AWS IoT Core<br/>(MQTT Broker)
    participant RuleEngine as 📋 IoT Rule Engine
    participant LambdaProc as ⚡ Lambda:<br/>iot-processor
    participant InfluxDB as 📊 InfluxDB<br/>(Time-series)
    participant DDB_Devices as 🗄️ DynamoDB:<br/>devices
    participant SNS as 🔔 AWS SNS<br/>(Email Alert)
    participant App as 📱 Mobile App
    participant APIGW as 🌐 API Gateway
    participant LambdaAPI as ⚡ Lambda: api

    Note over DHT11,SNS: ═══ PHASE 1: Device Boot & MQTT Connect ═══

    ESP32->>ESP32: app_main() → wifi_init()<br/>mqtt_app_start(thing_name)
    ESP32->>IoTCore: MQTT CONNECT mqtts:8883<br/>ClientId:"sensor-{thingName}"<br/>Cert: permanent cert (NVS)
    IoTCore-->>ESP32: CONNACK ✅

    ESP32->>ESP32: shadow_handler_init()<br/>Subscribe: $aws/things/{id}/shadow/update/delta<br/>Subscribe: $aws/things/{id}/shadow/get/accepted
    ESP32->>ESP32: mqtt_publish_status(true)
    ESP32->>IoTCore: PUBLISH: devices/{thingName}/status<br/>{ deviceId, deviceType:"sensor",<br/>  firmwareVersion:"1.0.0", online:true }

    Note over DHT11,SNS: ═══ PHASE 2: Rule Engine → DynamoDB Status ═══

    IoTCore->>RuleEngine: Match rule: device_status<br/>SQL: SELECT *, topic(2) as deviceId,<br/>     timestamp() as lastSeen<br/>     FROM 'devices/+/status'
    RuleEngine->>DDB_Devices: DynamoDB PutItem<br/>{ deviceId, online:true, lastSeen, firmwareVersion }

    Note over DHT11,SNS: ═══ PHASE 3: Telemetry Collection Loop (every 10s) ═══

    loop Mỗi 10 giây (TELEMETRY_INTERVAL_MS = 10000)
        ESP32->>DHT11: dht11_read() GPIO read
        DHT11-->>ESP32: { temperature: 28.5, humidity: 65.0 }
        
        ESP32->>ESP32: mqtt_publish_telemetry(&reading)<br/>→ shadow_report_state(temp, hum)
        
        par Publish telemetry MQTT topic
            ESP32->>IoTCore: PUBLISH QoS1: devices/{thingName}/telemetry<br/>{ deviceId, deviceType:"sensor",<br/>  temperature: 28.5, humidity: 65.0 }
        and Update Device Shadow
            ESP32->>IoTCore: PUBLISH QoS1: $aws/things/{id}/shadow/update<br/>{ state:{ reported:{ temperature:28.5,<br/>  humidity:65.0, firmwareVersion:"1.0.0" } } }
        end
    end

    Note over DHT11,SNS: ═══ PHASE 4: Rule Engine Telemetry Processing ═══

    IoTCore->>RuleEngine: Match rule: process_all_telemetry<br/>SQL: SELECT *, topic(2) as deviceId<br/>     FROM 'devices/+/telemetry'
    RuleEngine->>LambdaProc: invoke<br/>{ deviceId, temperature:28.5,<br/>  humidity:65.0, deviceType:"sensor" }

    par Write to InfluxDB
        LambdaProc->>LambdaProc: getInfluxToken()<br/>(cache from SecretsManager)
        LambdaProc->>InfluxDB: writePoint: temperature<br/>tag:deviceId="sensor-xxx", value=28.5
        LambdaProc->>InfluxDB: writePoint: humidity<br/>tag:deviceId="sensor-xxx", value=65.0
    and Update DynamoDB
        LambdaProc->>DDB_Devices: UpdateItem<br/>SET lastSeen=now, deviceType, lastTemperature, lastHumidity
    end

    Note over DHT11,SNS: ═══ PHASE 5: Threshold Alert (Conditional) ═══

    alt Nhiệt độ > 35°C HOẶC Độ ẩm > 80%
        IoTCore->>RuleEngine: Match rule: high_temp_alert<br/>SQL: SELECT ... WHERE temperature > 35 OR humidity > 80
        RuleEngine->>LambdaProc: invoke (same Lambda)
        LambdaProc->>SNS: Publish<br/>Subject: "[IoT Alert] High temperature: 36.2°C"<br/>MessageAttributes: { deviceId, alertType:"threshold" }
        SNS-->>User: 📧 Email Alert
    end

    Note over DHT11,SNS: ═══ PHASE 6: Mobile Real-time Monitoring ═══

    App->>APIGW: GET /devices/{deviceId}/telemetry?minutes=60<br/>[JWT Bearer]
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>DDB_Devices: GetItem(userId, deviceId) → ownership check
    LambdaAPI->>LambdaAPI: getInfluxToken()
    LambdaAPI->>InfluxDB: InfluxQL HTTP GET /query<br/>SELECT value FROM temperature,humidity<br/>WHERE deviceId='sensor-xxx'<br/>AND time > now()-60m<br/>ORDER BY time DESC LIMIT 200
    InfluxDB-->>LambdaAPI: JSON series:<br/>{ results:[{ series:[{ name:"temperature",<br/>  columns:["time","value"],<br/>  values:[[ts,28.5],...] }] }] }
    LambdaAPI->>LambdaAPI: Flatten multi-series →<br/>[{time, measure:"temperature", value:28.5}, ...]
    LambdaAPI-->>App: 200 [{ time, measure, value }, ...]
    App->>App: Render LineChart (MonitoringScreen)

    Note over DHT11,SNS: ═══ PHASE 7: Status Publish (every 30s) ═══

    loop Mỗi 30 giây (STATUS_PUBLISH_INTERVAL_MS = 30000)
        ESP32->>IoTCore: PUBLISH: devices/{thingName}/status<br/>{ deviceId, deviceType, firmwareVersion, online:true }
        IoTCore->>RuleEngine: Match rule: device_status
        RuleEngine->>DDB_Devices: PutItem (update lastSeen)
    end
```

---

## MQTT Topics Used

| Topic Pattern | Direction | QoS | Mô tả |
|--------------|-----------|-----|-------|
| `devices/{thingName}/telemetry` | Device → Cloud | 1 | Telemetry nhiệt độ/độ ẩm mỗi 10s |
| `devices/{thingName}/status` | Device → Cloud | 1 | Heartbeat online mỗi 30s |
| `$aws/things/{id}/shadow/update` | Device → Cloud | 1 | Báo cáo trạng thái vào Shadow |
| `$aws/things/{id}/shadow/update/delta` | Cloud → Device | 1 | Cloud muốn device thay đổi |
| `$aws/things/{id}/shadow/get` | Device → Cloud | 1 | Device yêu cầu trạng thái Shadow |
| `$aws/things/{id}/shadow/get/accepted` | Cloud → Device | 1 | Cloud trả về Shadow state |

---

## IoT Rule Engine SQL

```sql
-- Rule 1: Tất cả telemetry → Lambda (store + process)
SELECT *, topic(2) as deviceId
FROM 'devices/+/telemetry'
-- Action: invoke Lambda iot-processor

-- Rule 2: Alert khi vượt ngưỡng → Lambda
SELECT *, topic(2) as deviceId
FROM 'devices/+/telemetry'
WHERE temperature > 35 OR humidity > 80
-- Action: invoke Lambda iot-processor

-- Rule 3: Status → DynamoDB trực tiếp
SELECT *, topic(2) as deviceId, timestamp() as lastSeen
FROM 'devices/+/status'
-- Action: DynamoDB PutItem → devices table
```

---

## InfluxDB Data Model

```
Measurement: temperature
  Tag:   deviceId = "sensor-C3F9A..."
  Field: value    = 28.5 (float)
  Time:  1714000000000 (ms)

Measurement: humidity
  Tag:   deviceId = "sensor-C3F9A..."
  Field: value    = 65.0 (float)
  Time:  1714000000000 (ms)
```

---

## Alert Thresholds

| Metric | Ngưỡng | Action |
|--------|--------|--------|
| `temperature` | > 35°C | SNS → Email alert |
| `humidity` | > 80% | SNS → Email alert |

---

## Source Code References

| File | Vai trò |
|------|---------|
| `device/sensor/src/dht11_driver.c` | GPIO driver đọc DHT11 |
| `device/sensor/src/iot_mqtt_client.c` | `mqtt_publish_telemetry()`, `mqtt_publish_status()` |
| `device/sensor/src/shadow_handler.c` | `shadow_report_state()` |
| `device/sensor/src/main.c` | `telemetry_task()` (10s loop), `status_task()` (30s loop) |
| `device/sensor/src/config.h` | `TELEMETRY_INTERVAL_MS=10000`, `STATUS_PUBLISH_INTERVAL_MS=30000` |
| `backend/functions/iot-processor/handler.js` | Write InfluxDB, update DynamoDB, SNS publish |
| `backend/functions/api/handler.js` | `getTelemetry()` InfluxQL query |
| `infra/modules/iot/iot_core.tf` | Topic rules: `process_all_telemetry`, `high_temp_alert`, `device_status` |
| `mobile/src/screens/MonitoringScreen.jsx` | UI hiển thị chart telemetry |
