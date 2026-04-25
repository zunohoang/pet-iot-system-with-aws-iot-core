import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useDeviceShadow } from "../hooks/useDeviceShadow";

export default function DeviceControlScreen({ route }) {
  const { device } = route.params;
  const deviceId = device.deviceId;

  const { reportedState, desiredState, isOnline, loading, updateDesired } =
    useDeviceShadow(deviceId, device.online);

  const relayOn = (reportedState?.relay ?? desiredState?.relay) === "ON";
  const isChanging =
    reportedState?.relay !== desiredState?.relay &&
    desiredState?.relay !== undefined;

  const toggleRelay = async () => {
    const next = relayOn ? "OFF" : "ON";
    try {
      await updateDesired({ relay: next });
    } catch (err) {
      Alert.alert("Error", "Failed to update device state");
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.loadingText}>Loading device state...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Device Info */}
      <View style={styles.infoCard}>
        <View style={styles.infoRow}>
          <Text style={styles.label}>Device ID</Text>
          <Text style={styles.value}>{deviceId}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.label}>Status</Text>
          <View style={styles.statusWrap}>
            <View
              style={[
                styles.dot,
                { backgroundColor: isOnline ? "#22c55e" : "#ef4444" },
              ]}
            />
            <Text
              style={[
                styles.value,
                { color: isOnline ? "#22c55e" : "#ef4444" },
              ]}
            >
              {isOnline ? "Online" : "Offline"}
            </Text>
          </View>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.label}>Firmware</Text>
          <Text style={styles.value}>
            {reportedState?.firmwareVersion || "—"}
          </Text>
        </View>
      </View>

      {!isOnline && (
        <View style={styles.warnCard}>
          <Text style={styles.warnText}>
            Device chưa online. Hãy đảm bảo switch đã nhận WiFi + provisioning
            claim qua BLE và đã kết nối AWS IoT.
          </Text>
        </View>
      )}

      {/* Relay Control */}
      <View style={styles.controlSection}>
        <Text style={styles.controlLabel}>Light Control</Text>

        <TouchableOpacity
          style={[styles.toggleButton, relayOn && styles.toggleOn]}
          onPress={toggleRelay}
          disabled={!isOnline || isChanging}
          activeOpacity={0.8}
        >
          {isChanging ? (
            <ActivityIndicator size="large" color="#fff" />
          ) : (
            <>
              <Ionicons
                name={relayOn ? "bulb" : "bulb-outline"}
                size={56}
                color={relayOn ? "#fbbf24" : "#475569"}
              />
              <Text
                style={[styles.toggleLabel, relayOn && styles.toggleLabelOn]}
              >
                {relayOn ? "ON" : "OFF"}
              </Text>
            </>
          )}
        </TouchableOpacity>

        {!isOnline && (
          <Text style={styles.offlineHint}>
            Device is offline — commands will be applied when it reconnects
          </Text>
        )}
      </View>

      {/* Shadow State */}
      <View style={styles.shadowCard}>
        <Text style={styles.shadowTitle}>Shadow State</Text>
        <View style={styles.shadowRow}>
          <Text style={styles.shadowLabel}>Desired</Text>
          <Text style={styles.shadowValue}>{desiredState?.relay || "—"}</Text>
        </View>
        <View style={styles.shadowRow}>
          <Text style={styles.shadowLabel}>Reported</Text>
          <Text style={styles.shadowValue}>{reportedState?.relay || "—"}</Text>
        </View>
        {isChanging && (
          <Text style={styles.pendingText}>
            Waiting for device acknowledgment...
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a", padding: 16 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0f172a",
  },
  loadingText: { color: "#64748b", marginTop: 12 },
  infoCard: {
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  warnCard: {
    backgroundColor: "#3f1d1d",
    borderColor: "#7f1d1d",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  warnText: { color: "#fecaca", fontSize: 12, lineHeight: 18 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
  },
  label: { fontSize: 13, color: "#64748b" },
  value: { fontSize: 14, fontWeight: "500", color: "#f1f5f9" },
  statusWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  controlSection: { alignItems: "center", paddingVertical: 24 },
  controlLabel: {
    fontSize: 16,
    fontWeight: "600",
    color: "#94a3b8",
    marginBottom: 28,
  },
  toggleButton: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "#334155",
  },
  toggleOn: {
    backgroundColor: "#1c1917",
    borderColor: "#fbbf24",
    shadowColor: "#fbbf24",
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 8,
  },
  toggleLabel: {
    fontSize: 20,
    fontWeight: "700",
    color: "#475569",
    marginTop: 6,
  },
  toggleLabelOn: { color: "#fbbf24" },
  offlineHint: {
    fontSize: 12,
    color: "#f59e0b",
    textAlign: "center",
    marginTop: 16,
    paddingHorizontal: 24,
  },
  shadowCard: {
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 16,
    marginTop: 8,
  },
  shadowTitle: { fontSize: 13, color: "#64748b", marginBottom: 10 },
  shadowRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  shadowLabel: { fontSize: 13, color: "#94a3b8" },
  shadowValue: { fontSize: 14, fontWeight: "500", color: "#f1f5f9" },
  pendingText: { fontSize: 12, color: "#f59e0b", marginTop: 8 },
});
