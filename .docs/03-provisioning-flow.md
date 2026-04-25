# Luồng 03: Device Provisioning & Claiming Mechanism

> **Mô tả:** Luồng đăng ký thiết bị mới từ lần đầu bật nguồn đến khi device kết nối thành công vào AWS IoT Core với certificate vĩnh cửu. Sử dụng mô hình **Trusted User Fleet Provisioning**.

---

## Tổng Quan Luồng

```
[User] → (Scan QR / chọn device type) → [Mobile App]
       → POST /devices/claim/auto hoặc /devices/claim
       → POST /devices/provisioning-claim (lấy short-lived cert)
       → BLE GATT → [ESP32 Device]
       → WiFi connect
       → MQTT Fleet Provisioning → [AWS IoT Core]
       → Lambda Pre-Provisioning Hook
       → Certificate + ThingName → Device NVS
       → MQTT normal operation
```

---

## Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant App as 📱 Mobile App<br/>(React Native)
    participant Cognito as 🔐 AWS Cognito
    participant APIGW as 🌐 API Gateway 
    participant LambdaAPI as ⚡ Lambda: api
    participant DDB_Claims as 🗄️ DynamoDB<br/>device-claims
    participant DDB_UserDev as 🗄️ DynamoDB<br/>user-device
    participant DDB_Devices as 🗄️ DynamoDB<br/>devices
    participant IoTCore as ☁️ AWS IoT Core<br/>Fleet Provisioning
    participant LambdaHook as ⚡ Lambda:<br/>provisioning-hook
    participant Device as 🔌 ESP32<br/>(BLE + WiFi)

    Note over User,Device: ═══ PHASE 1: User Login ═══

    User->>App: Mở app, nhập credentials
    App->>Cognito: SignIn (email + password)
    Cognito-->>App: JWT ID Token (sub = userId)

    Note over User,Device: ═══ PHASE 2: Claim Device (User scans QR or selects type) ═══

    User->>App: Nhấn "Add Device" → chọn device type (switch/sensor)
    App->>APIGW: POST /devices/claim/auto<br/>{ deviceType: "switch" }  [JWT Bearer]
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>DDB_Claims: PutItem { claimId, deviceType, userId,<br/>used:false, expiresAt: now+30min }
    DDB_Claims-->>LambdaAPI: OK
    LambdaAPI-->>App: 201 { claimId: "C3F9A...", expiresAt }

    Note over User,Device: ═══ PHASE 3: Get Short-Lived Provisioning Certificate ═══

    App->>APIGW: POST /devices/provisioning-claim<br/>{ claimId: "C3F9A..." }  [JWT Bearer]
    APIGW->>LambdaAPI: invoke
    LambdaAPI->>DDB_Claims: GetItem(claimId) → verify userId matches, not used
    LambdaAPI->>IoTCore: CreateProvisioningClaim(templateName:<br/>"iot-smarthome-SwitchTemplate")
    IoTCore-->>LambdaAPI: { certificatePem, privateKey,<br/>certificateId, expiration }
    LambdaAPI-->>App: 200 { certificatePem, privateKey,<br/>iotDataEndpoint, claimId, templateName }

    Note over User,Device: ═══ PHASE 4: BLE Provisioning (Mobile → Device) ═══

    App->>App: buildDeviceSetupPayload()<br/>{ version, deviceType, wifi:{ssid,pass},<br/>  iot:{cert, key, endpoint, claimId} }
    App->>Device: BLE Scan → Detect "IOT-PROV-XXXXXX"
    App->>Device: BLE Connect + Discover Services
    App->>Device: BLE GATT Write: "BEGIN:{length}"
    Device-->>App: Notify: "ACK:BEGIN"
    loop Gửi từng chunk 180 bytes
        App->>Device: BLE GATT Write: chunk[i]
    end
    App->>Device: BLE GATT Write: "END"
    Device->>Device: process_payload_json()<br/>→ provisioning_set_wifi_credentials()<br/>→ provisioning_set_trusted_user_credentials()
    Device->>Device: Lưu vào NVS:<br/>claim_cert, claim_key, iot_host, claim_id,<br/>wifi_ssid, wifi_pass
    Device-->>App: Notify: "ACK:OK"
    Device->>Device: esp_restart()

    Note over User,Device: ═══ PHASE 5: Device Fleet Provisioning (Device → AWS) ═══

    Device->>Device: Boot: provisioning_is_done() = false<br/>provisioning_has_claim_credentials() = true
    Device->>Device: wifi_init() → Connect WiFi
    Device->>IoTCore: MQTT Connect mqtts:8883<br/>ClientId:"claim-sensor" / "claim-switch"<br/>Cert: short-lived claim cert
    IoTCore-->>Device: CONNACK

    Device->>IoTCore: SUBSCRIBE: $aws/certificates/create/json/accepted<br/>SUBSCRIBE: $aws/certificates/create/json/rejected
    Device->>IoTCore: PUBLISH: $aws/certificates/create/json  {}

    Note over IoTCore: IoT Core creates temporary<br/>certificate material
    IoTCore-->>Device: $aws/certificates/create/json/accepted<br/>{ certificateOwnershipToken,<br/>  certificatePem, privateKey }

    Device->>Device: Lưu s_cert_ownership_token<br/>s_new_cert_pem, s_new_private_key

    Device->>IoTCore: SUBSCRIBE: $aws/.../SwitchTemplate/provision/json/accepted<br/>SUBSCRIBE: .../rejected
    Device->>IoTCore: PUBLISH: $aws/provisioning-templates/SwitchTemplate/provision/json<br/>{ certificateOwnershipToken, parameters:{ClaimId, DeviceType} }

    IoTCore->>LambdaHook: invoke (Pre-Provisioning Hook)<br/>{ parameters:{ClaimId, DeviceType}, claimCertificateId }
    LambdaHook->>DDB_Claims: GetItem(claimId)
    Note over LambdaHook: Validate: claimId exists, not used, has userId
    LambdaHook->>DDB_UserDev: PutItem { userId, deviceId:"switch-{claimId}",<br/>deviceType, claimId, provisionedAt }
    LambdaHook->>DDB_Devices: PutItem { deviceId:"switch-{claimId}",<br/>deviceType, status:"provisioned" }
    LambdaHook->>DDB_Claims: UpdateItem SET used=true, usedAt=now
    LambdaHook-->>IoTCore: { allowProvisioning: true }

    IoTCore->>IoTCore: Tạo Thing: "switch-{claimId}"<br/>Kích hoạt certificate vĩnh cửu<br/>Đính kèm policy SwitchDevicePolicy<br/>Thêm vào group "iot-smarthome-switches"
    IoTCore-->>Device: .../SwitchTemplate/provision/json/accepted<br/>{ thingName: "switch-{claimId}" }

    Device->>Device: Lưu NVS:<br/>thing_name, cert_pem, priv_key, provisioned=1<br/>Xóa claim_cert, claim_key, claim_id
    Device->>Device: esp_restart() → Runtime mode

    Note over User,Device: ═══ PHASE 6: Normal MQTT Operation ═══

    Device->>Device: provisioning_is_done() = true
    Device->>Device: wifi_init() → mqtt_app_start(thing_name)
    Device->>IoTCore: MQTT Connect mqtts:8883<br/>ClientId:"switch-{thingName}"<br/>Cert: permanent cert (from NVS)
    IoTCore-->>Device: CONNACK ✅
    Device->>IoTCore: SUBSCRIBE: $aws/things/{thingName}/shadow/update/delta
    Device->>IoTCore: PUBLISH: devices/{thingName}/status { online:true }
```

---

## Bảng Mô Tả Chi Tiết

| Bước | Actor | Action | Artifact |
|------|-------|--------|----------|
| 1 | User | Đăng nhập app | Cognito JWT |
| 2 | Mobile | POST `/devices/claim/auto` | `claimId` trong DynamoDB |
| 3 | Mobile | POST `/devices/provisioning-claim` | Short-lived cert (X.509) |
| 4 | Mobile→Device | BLE GATT Write (chunked JSON) | WiFi + cert lưu vào NVS |
| 5 | Device | MQTT Fleet Provisioning Step 1 | `certificateOwnershipToken` |
| 6 | Device | MQTT Fleet Provisioning Step 2 | Hook Lambda → Thing + policy |
| 7 | Hook | Validate claimId, write DB | `allowProvisioning: true` |
| 8 | Device | Lưu permanent cert vào NVS | `provisioned = 1` |
| 9 | Device | Restart → normal MQTT mode | Online thành công |

---

## NVS Storage Schema

```
Namespace: "iot_cfg"
┌─────────────────┬──────────────────────────────────────────────────────┐
│ Key             │ Value                                                │
├─────────────────┼──────────────────────────────────────────────────────┤
│ wifi_ssid       │ "MyHomeWifi"                                         │
│ wifi_pass       │ "password123"                                        │
│ iot_host        │ "a10xp7m81hk5fg-ats.iot.ap-southeast-1.amazonaws.com"│
│ claim_id        │ "C3F9A..." (xóa sau provisioning)                   │
│ claim_cert      │ PEM (short-lived, xóa sau provisioning)             │
│ claim_key       │ PEM (short-lived, xóa sau provisioning)             │
│ thing_name      │ "switch-C3F9A..." (sau provisioning)                │
│ cert_pem        │ PEM vĩnh cửu (sau provisioning)                     │
│ priv_key        │ PEM vĩnh cửu (sau provisioning)                     │
│ provisioned     │ 1 (uint8)                                            │
└─────────────────┴──────────────────────────────────────────────────────┘
```

---

## Source Code References

| File | Vai trò |
|------|---------|
| `mobile/src/services/ble.js` | BLE scan, connect, gửi payload chunks |
| `mobile/src/services/api.js` | `createAutoClaim()`, `createProvisioningClaim()` |
| `mobile/src/screens/AddDeviceScreen.jsx` | UI flow provisioning |
| `device/switch/src/ble_provisioning.c` | NimBLE GATT server, nhận payload |
| `device/switch/src/provisioning.c` | `provisioning_run()`, Fleet Provisioning MQTT |
| `device/switch/src/main.c` | Orchestration flow: BLE → WiFi → MQTT |
| `backend/functions/api/handler.js` | `autoClaimDevice()`, `postProvisioningClaim()` |
| `backend/functions/provisioning-hook/handler.js` | Pre-Provisioning Hook Lambda |
| `infra/modules/provisioning/fleet_provisioning.tf` | IoT Template SwitchTemplate + SensorTemplate |
| `infra/modules/data/dynamodb.tf` | device-claims, user-device, devices tables |
