import React, { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { createAutoClaim, createProvisioningClaim } from "../services/api";
import {
  buildDeviceSetupPayload,
  ensureBleReady,
  scanForProvisioningDevice,
  connectProvisioningDevice,
  sendDeviceSetupOverBle,
  disconnectProvisioningDevice,
} from "../services/ble";

export default function AddDeviceScreen() {
  const [deviceType, setDeviceType] = useState("switch");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPass, setWifiPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("idle");
  const [statusText, setStatusText] = useState("Ready to setup a new device.");
  const [result, setResult] = useState(null);

  useEffect(
    () => () => {
      disconnectProvisioningDevice();
    },
    [],
  );

  const onStartSetup = useCallback(async () => {
    if (!wifiSsid.trim()) {
      Alert.alert("WiFi required", "Please enter WiFi SSID before continuing.");
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const seenBleNames = new Set();
      setStage("ble_ready");
      setStatusText("Checking Bluetooth and requesting BLE permissions...");
      console.log("[AddDevice] stage=ble_ready1");
      await ensureBleReady();

      setStage("scan");
      setStatusText("Scanning nearby provisioning devices...");
      console.log("[AddDevice] stage=scan");
      const device = await scanForProvisioningDevice({
        onDeviceSeen: ({ name, id, rssi }) => {
          if (!name) return;
          const label = `${name} (${id.slice(-5)})`;
          if (!seenBleNames.has(label)) {
            seenBleNames.add(label);
            const list = Array.from(seenBleNames).slice(0, 6).join(", ");
            setStatusText(
              `Scanning nearby provisioning devices... Seen: ${list}`,
            );
          }
          console.log("[AddDevice] scan seen", { name, id, rssi });
        },
      });

      setStage("connect");
      setStatusText(
        `Connecting to ${device.name || device.localName || device.id}...`,
      );
      console.log("[AddDevice] stage=connect", {
        deviceId: device.id,
        name: device.name || device.localName,
      });
      await connectProvisioningDevice(device.id);

      setStage("claim");
      setStatusText("Requesting auto claim code from backend...");
      console.log("[AddDevice] stage=claim", { deviceType });
      const claim = await createAutoClaim(deviceType);

      setStage("bundle");
      setStatusText("Generating short-lived provisioning certificate...");
      console.log("[AddDevice] stage=bundle", { claimId: claim.claimId });
      const provisioning = await createProvisioningClaim(claim.claimId);

      setStage("send");
      setStatusText("Sending WiFi + provisioning bundle over BLE...");
      console.log("[AddDevice] stage=send", {
        claimId: claim.claimId,
        template: provisioning.templateName,
      });
      const payload = buildDeviceSetupPayload({
        wifiSsid,
        wifiPassword: wifiPass,
        provisioning,
        deviceType,
      });
      const ack = await sendDeviceSetupOverBle(device.id, payload);

      setStage("success");
      setStatusText(
        "Setup payload sent. Device will provision and appear in your dashboard shortly.",
      );
      setResult({
        deviceName: device.name || device.localName || device.id,
        claimId: claim.claimId,
        templateName: provisioning.templateName,
        ack: ack || null,
      });
      console.log("[AddDevice] stage=success", { ack: ack || null });
      Alert.alert(
        "Setup sent",
        "Device received setup payload. Wait ~10-30 seconds for it to come online.",
      );
    } catch (e) {
      setStage("error");
      setStatusText(e.message || "Setup failed");
      console.error("[AddDevice] stage=error", e);
      Alert.alert("Setup failed", e.message || "Please retry");
    } finally {
      setLoading(false);
    }
  }, [wifiSsid, wifiPass, deviceType]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>
        Chọn loại thiết bị, nhập WiFi, bật BLE và nhấn Start setup. Ứng dụng sẽ
        tự scan thiết bị, tạo claim code, lấy cert ngắn hạn và gửi payload qua
        BLE.
      </Text>

      <Text style={styles.label}>Device type</Text>
      <View style={styles.typeRow}>
        <TouchableOpacity
          style={[
            styles.typeBtn,
            deviceType === "switch" && styles.typeBtnActive,
          ]}
          onPress={() => setDeviceType("switch")}
          disabled={loading}
        >
          <Text
            style={[
              styles.typeText,
              deviceType === "switch" && styles.typeTextActive,
            ]}
          >
            Switch bóng đèn
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.typeBtn,
            deviceType === "sensor" && styles.typeBtnActive,
          ]}
          onPress={() => setDeviceType("sensor")}
          disabled={loading}
        >
          <Text
            style={[
              styles.typeText,
              deviceType === "sensor" && styles.typeTextActive,
            ]}
          >
            Sensor nhiệt độ
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="small" color="#6366f1" style={styles.spin} />
      ) : null}

      <Text style={styles.subTitle}>WiFi for device (sent over BLE)</Text>
      <TextInput
        style={styles.input}
        value={wifiSsid}
        onChangeText={setWifiSsid}
        placeholder="SSID"
        placeholderTextColor="#64748b"
      />
      <TextInput
        style={styles.input}
        value={wifiPass}
        onChangeText={setWifiPass}
        placeholder="Password"
        placeholderTextColor="#64748b"
        secureTextEntry
      />

      <TouchableOpacity
        style={styles.btn}
        onPress={onStartSetup}
        disabled={loading}
      >
        <Text style={styles.btnText}>
          {loading ? "Setting up..." : "Start setup via BLE"}
        </Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.cardLine}>Stage: {stage}</Text>
        <Text style={styles.cardLine}>{statusText}</Text>
      </View>

      {result ? (
        <View style={styles.card}>
          <Text style={styles.cardLine}>Device: {result.deviceName}</Text>
          <Text style={styles.cardLine}>ClaimId: {result.claimId}</Text>
          <Text style={styles.cardLine}>Template: {result.templateName}</Text>
          <Text style={styles.cardLine}>BLE Ack: {result.ack || "none"}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  content: { padding: 20, paddingBottom: 40 },
  hint: { color: "#94a3b8", fontSize: 13, marginBottom: 20, lineHeight: 20 },
  label: { color: "#64748b", fontSize: 12, marginBottom: 6 },
  subTitle: {
    color: "#cbd5e1",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 20,
    marginBottom: 8,
  },
  typeRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  typeBtn: {
    flex: 1,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 12,
    alignItems: "center",
  },
  typeBtnActive: { backgroundColor: "#3730a3" },
  typeText: { color: "#cbd5e1", fontSize: 13, fontWeight: "600" },
  typeTextActive: { color: "#e0e7ff" },
  input: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
    color: "#f1f5f9",
    fontSize: 16,
    marginBottom: 10,
  },
  btn: {
    backgroundColor: "#4f46e5",
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
    marginTop: 8,
  },
  btnText: { color: "#f1f5f9", fontWeight: "600" },
  spin: { marginVertical: 8 },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  cardLine: { color: "#cbd5e1", fontSize: 12, marginBottom: 4 },
});
