import { Buffer } from "buffer";
import { Platform, PermissionsAndroid } from "react-native";
import Constants from "expo-constants";
import { BleManager } from "react-native-ble-plx";

let bleManager = null;
let connectedDevice = null;

const extra =
  Constants.expoConfig?.extra ||
  Constants.manifest?.extra ||
  Constants.manifest2?.extra ||
  {};
const PROV_SERVICE_UUID = (extra.BLE_PROV_SERVICE_UUID || "").toLowerCase();
const PROV_WRITE_CHAR_UUID = (
  extra.BLE_PROV_WRITE_CHAR_UUID || ""
).toLowerCase();
const PROV_NOTIFY_CHAR_UUID = (
  extra.BLE_PROV_NOTIFY_CHAR_UUID || ""
).toLowerCase();
const DEVICE_NAME_PREFIX = extra.BLE_DEVICE_NAME_PREFIX || "IOT-PROV-";
const LEGACY_DEVICE_NAMES = ["ESP32_BLE"];

function getBleManager() {
  const appOwnership = Constants.appOwnership || "unknown";
  if (appOwnership === "expo") {
    throw new Error(
      "BLE provisioning requires a development build. Expo Go does not support react-native-ble-plx.",
    );
  }
  if (bleManager) return bleManager;
  try {
    bleManager = new BleManager();
    return bleManager;
  } catch (e) {
    throw new Error(
      "BLE native module is unavailable. Build a development client and reinstall the app.",
    );
  }
}

function toBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function fromBase64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

export function buildDeviceSetupPayload({
  wifiSsid,
  wifiPassword,
  provisioning,
  deviceType,
}) {
  if (!wifiSsid?.trim()) throw new Error("WiFi SSID is required");
  if (
    !provisioning?.certificatePem ||
    !provisioning?.privateKey ||
    !provisioning?.claimId
  ) {
    throw new Error("Invalid provisioning object");
  }
  return JSON.stringify({
    version: 1,
    deviceType: deviceType || provisioning.deviceType || "switch",
    wifi: { ssid: wifiSsid.trim(), password: wifiPassword || "" },
    iot: {
      iotDataEndpoint: provisioning.iotDataEndpoint,
      templateName: provisioning.templateName,
      certificatePem: provisioning.certificatePem,
      privateKey: provisioning.privateKey,
      expiration: provisioning.expiration,
      certificateId: provisioning.certificateId,
      claimId: provisioning.claimId,
    },
  });
}

async function requestAndroidBlePermissions() {
  if (Platform.OS !== "android") return true;

  const permissions = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ];
  const results = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every(
    (p) => results[p] === PermissionsAndroid.RESULTS.GRANTED,
  );
}

function waitForBluetoothPowerOn(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      sub?.remove();
      reject(new Error("Bluetooth is off. Please turn on BLE and try again."));
    }, timeoutMs);

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      sub?.remove();
      resolve();
    };

    let sub = null;
    const manager = getBleManager();
    manager
      .state()
      .then((state) => {
        if (state === "PoweredOn") {
          finish();
          return;
        }
        if (state === "Unsupported") {
          clearTimeout(timeoutId);
          done = true;
          sub?.remove();
          reject(new Error("This device does not support BLE."));
        }
      })
      .catch(() => {});

    sub = manager.onStateChange((state) => {
      if (state === "PoweredOn") finish();
    }, true);
  });
}

export async function ensureBleReady() {
  const granted = await requestAndroidBlePermissions();
  if (!granted) {
    throw new Error("Bluetooth permission denied");
  }
  await waitForBluetoothPowerOn();
}

export async function scanForProvisioningDevice({
  timeoutMs = 15000,
  onDeviceSeen,
} = {}) {
  await ensureBleReady();

  return new Promise((resolve, reject) => {
    const manager = getBleManager();
    // Debug-first scan: do not pre-filter by service UUID.
    // Some peripherals advertise name but not full 128-bit UUID in ADV packet.
    const scanServiceUuids = null;
    const seenDevices = new Map();
    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      manager.stopDeviceScan();
      const seenSummary = Array.from(seenDevices.values())
        .slice(0, 12)
        .map((d) => `${d.name} (${d.id})`)
        .join(", ");
      const details = seenSummary ? ` Seen devices: ${seenSummary}` : "";
      reject(new Error(`No provisioning device found over BLE.${details}`));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      manager.stopDeviceScan();
      fn(value);
    };

    manager.startDeviceScan(scanServiceUuids, null, (error, device) => {
      if (error) {
        finish(reject, new Error(`BLE scan failed: ${error.message}`));
        return;
      }
      if (!device) return;

      const name = device.name || device.localName || "";
      const displayName = name || "<no-name>";
      seenDevices.set(device.id, { id: device.id, name: displayName, rssi: device.rssi });
      onDeviceSeen?.({ id: device.id, name: displayName, rssi: device.rssi });
      console.log("[BLE] scan seen", { id: device.id, name: displayName });
      const isPrefixMatch = displayName.startsWith(DEVICE_NAME_PREFIX);
      const isLegacyMatch = LEGACY_DEVICE_NAMES.includes(displayName);
      if (isPrefixMatch || isLegacyMatch) {
        console.log("[BLE] scan matched", {
          id: device.id,
          name: displayName,
          prefix: DEVICE_NAME_PREFIX,
          legacy: isLegacyMatch,
        });
        finish(resolve, device);
      }
    });
  });
}

export async function connectProvisioningDevice(deviceId) {
  await ensureBleReady();
  const manager = getBleManager();
  const device = await manager.connectToDevice(deviceId, { timeout: 12000 });
  const ready = await device.discoverAllServicesAndCharacteristics();
  connectedDevice = ready;
  return ready;
}

function waitForAck(device, timeoutMs = 5000) {
  if (!PROV_NOTIFY_CHAR_UUID) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub?.remove();
      resolve(null);
    }, timeoutMs);

    const sub = device.monitorCharacteristicForService(
      PROV_SERVICE_UUID,
      PROV_NOTIFY_CHAR_UUID,
      (error, characteristic) => {
        if (error) return;
        if (!characteristic?.value) return;
        clearTimeout(timer);
        sub?.remove();
        resolve(fromBase64(characteristic.value));
      },
    );
  });
}

/**
 * Sends UTF-8 provisioning payload to a connected BLE device.
 * If the device exposes a notify characteristic, an optional ACK is awaited.
 */
export async function sendDeviceSetupOverBle(deviceId, utf8Payload) {
  if (!utf8Payload?.trim()) {
    throw new Error("Provisioning payload is empty");
  }
  if (!PROV_SERVICE_UUID || !PROV_WRITE_CHAR_UUID) {
    throw new Error("BLE provisioning UUIDs are not configured");
  }

  let device = connectedDevice;
  if (!device || device.id !== deviceId) {
    device = await connectProvisioningDevice(deviceId);
  }

  const CHUNK_SIZE = 180;
  const chunks = [];
  for (let i = 0; i < utf8Payload.length; i += CHUNK_SIZE) {
    chunks.push(utf8Payload.slice(i, i + CHUNK_SIZE));
  }

  console.log("[BLE] send begin", {
    deviceId,
    bytes: utf8Payload.length,
    chunks: chunks.length,
  });
  try {
    await device.writeCharacteristicWithResponseForService(
      PROV_SERVICE_UUID,
      PROV_WRITE_CHAR_UUID,
      toBase64(`BEGIN:${utf8Payload.length}`),
    );
    for (const chunk of chunks) {
      await device.writeCharacteristicWithResponseForService(
        PROV_SERVICE_UUID,
        PROV_WRITE_CHAR_UUID,
        toBase64(chunk),
      );
    }
    await device.writeCharacteristicWithResponseForService(
      PROV_SERVICE_UUID,
      PROV_WRITE_CHAR_UUID,
      toBase64("END"),
    );
  } catch (e) {
    const msg = e?.message || "";
    if (msg.includes("Characteristic") && msg.includes("not found")) {
      throw new Error(
        `Connected BLE device does not expose expected provisioning characteristic (${PROV_WRITE_CHAR_UUID}). ` +
          "Likely wrong firmware/UUID profile (e.g. legacy ESP32_BLE).",
      );
    }
    throw e;
  }
  console.log("[BLE] send done");

  return waitForAck(device);
}

export async function disconnectProvisioningDevice() {
  if (!connectedDevice) return;
  try {
    await connectedDevice.cancelConnection();
  } catch {
    /* ignore */
  } finally {
    connectedDevice = null;
  }
}
