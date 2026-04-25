/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Expo app config (single file — no app.json) + mobile-app/.env
 * (EXPO_PUBLIC_* or the same names without prefix).
 * Copy .env.example → .env
 */
require("dotenv").config();

const p = process.env;

const defaultExtra = {
  AWS_REGION: "ap-southeast-1",
  COGNITO_USER_POOL_ID: "REPLACE_WITH_TERRAFORM_OUTPUT",
  COGNITO_CLIENT_ID: "REPLACE_WITH_TERRAFORM_OUTPUT",
  COGNITO_IDENTITY_POOL_ID: "REPLACE_WITH_TERRAFORM_OUTPUT",
  API_BASE_URL: "REPLACE_WITH_TERRAFORM_OUTPUT",
  IOT_ENDPOINT: "REPLACE_WITH_IOT_ENDPOINT",
  BLE_PROV_SERVICE_UUID: "91bad492-b950-4226-aa2b-4ede9fa42f59",
  BLE_PROV_WRITE_CHAR_UUID: "cba1d466-344c-4be3-ab3f-318fdd809f18",
  BLE_PROV_NOTIFY_CHAR_UUID: "25c5d1a5-9f5f-4f34-9a4f-2f5df9f65d2f",
  BLE_DEVICE_NAME_PREFIX: "IOT-PROV-",
};

const extra = {
  ...defaultExtra,
  AWS_REGION:
    p.EXPO_PUBLIC_AWS_REGION || p.AWS_REGION || defaultExtra.AWS_REGION,
  COGNITO_USER_POOL_ID:
    p.EXPO_PUBLIC_COGNITO_USER_POOL_ID ||
    p.COGNITO_USER_POOL_ID ||
    defaultExtra.COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID:
    p.EXPO_PUBLIC_COGNITO_CLIENT_ID ||
    p.COGNITO_CLIENT_ID ||
    defaultExtra.COGNITO_CLIENT_ID,
  COGNITO_IDENTITY_POOL_ID:
    p.EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID ||
    p.COGNITO_IDENTITY_POOL_ID ||
    defaultExtra.COGNITO_IDENTITY_POOL_ID,
  API_BASE_URL:
    p.EXPO_PUBLIC_API_BASE_URL || p.API_BASE_URL || defaultExtra.API_BASE_URL,
  IOT_ENDPOINT:
    p.EXPO_PUBLIC_IOT_ENDPOINT || p.IOT_ENDPOINT || defaultExtra.IOT_ENDPOINT,
  BLE_PROV_SERVICE_UUID:
    p.EXPO_PUBLIC_BLE_PROV_SERVICE_UUID ||
    p.BLE_PROV_SERVICE_UUID ||
    defaultExtra.BLE_PROV_SERVICE_UUID,
  BLE_PROV_WRITE_CHAR_UUID:
    p.EXPO_PUBLIC_BLE_PROV_WRITE_CHAR_UUID ||
    p.BLE_PROV_WRITE_CHAR_UUID ||
    defaultExtra.BLE_PROV_WRITE_CHAR_UUID,
  BLE_PROV_NOTIFY_CHAR_UUID:
    p.EXPO_PUBLIC_BLE_PROV_NOTIFY_CHAR_UUID ||
    p.BLE_PROV_NOTIFY_CHAR_UUID ||
    defaultExtra.BLE_PROV_NOTIFY_CHAR_UUID,
  BLE_DEVICE_NAME_PREFIX:
    p.EXPO_PUBLIC_BLE_DEVICE_NAME_PREFIX ||
    p.BLE_DEVICE_NAME_PREFIX ||
    defaultExtra.BLE_DEVICE_NAME_PREFIX,
};

module.exports = {
  expo: {
    name: "IoT Smart Home",
    slug: "iot-smarthome",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    userInterfaceStyle: "automatic",
    splash: {
      image: "./assets/images/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#0f172a",
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: "com.iotsmarthome.app",
      infoPlist: {
        NSBluetoothAlwaysUsageDescription:
          "Ứng dụng cần Bluetooth để cấu hình thiết bị IoT qua BLE.",
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundColor: "#0f172a",
      },
      package: "com.iotsmarthome.app",
      permissions: [
        "INTERNET",
        "ACCESS_NETWORK_STATE",
        "BLUETOOTH",
        "BLUETOOTH_ADMIN",
        "BLUETOOTH_SCAN",
        "BLUETOOTH_CONNECT",
        "ACCESS_FINE_LOCATION",
      ],
    },
    web: {
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-font",
      [
        "expo-notifications",
        {
          icon: "./assets/images/icon.png",
          color: "#6366f1",
        },
      ],
      [
        "react-native-ble-plx",
        {
          isBackgroundEnabled: false,
          modes: ["central"],
          bluetoothAlwaysPermission:
            "Ứng dụng cần Bluetooth để thiết lập thiết bị IoT qua BLE.",
        },
      ],
    ],
    extra,
  },
};
