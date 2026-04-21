import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';

import { AuthProvider, useAuth } from './src/store/AuthContext';
import LoginScreen          from './src/screens/LoginScreen';
import DashboardScreen      from './src/screens/DashboardScreen';
import DeviceControlScreen  from './src/screens/DeviceControlScreen';
import MonitoringScreen     from './src/screens/MonitoringScreen';
import SceneScreen          from './src/screens/SceneScreen';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

const NAV_THEME = {
  dark:    true,
  colors: {
    primary:     '#6366f1',
    background:  '#0f172a',
    card:        '#1e293b',
    text:        '#f1f5f9',
    border:      '#334155',
    notification: '#6366f1',
  },
};

const SCREEN_OPTIONS = {
  headerStyle:      { backgroundColor: '#1e293b' },
  headerTintColor:  '#f1f5f9',
  headerTitleStyle: { fontWeight: '600' },
  headerShadowVisible: false,
};

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        ...SCREEN_OPTIONS,
        tabBarStyle: {
          backgroundColor: '#1e293b',
          borderTopColor:  '#334155',
          borderTopWidth:  1,
          paddingBottom:   8,
          height:          60,
        },
        tabBarActiveTintColor:   '#6366f1',
        tabBarInactiveTintColor: '#475569',
        tabBarLabelStyle: { fontSize: 11, marginTop: -2 },
        tabBarIcon: ({ color, size, focused }) => {
          const icons = {
            Devices: focused ? 'hardware-chip'       : 'hardware-chip-outline',
            Scenes:  focused ? 'flash'               : 'flash-outline',
          };
          return <Ionicons name={icons[route.name]} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Devices" component={DashboardScreen}
        options={{ title: 'Devices', headerTitle: 'IoT Smart Home' }} />
      <Tab.Screen name="Scenes"  component={SceneScreen}
        options={{ title: 'Scenes', headerTitle: 'Automations' }} />
    </Tab.Navigator>
  );
}

function AppNavigator() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' }}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={NAV_THEME}>
      <Stack.Navigator screenOptions={SCREEN_OPTIONS}>
        {!user ? (
          <Stack.Screen name="Login" component={LoginScreen}
            options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeTabs}
              options={{ headerShown: false }} />
            <Stack.Screen name="DeviceControl" component={DeviceControlScreen}
              options={({ route }) => ({
                title: route.params?.device?.deviceId || 'Device Control',
              })} />
            <Stack.Screen name="Monitoring" component={MonitoringScreen}
              options={({ route }) => ({
                title: route.params?.device?.deviceId || 'Monitoring',
              })} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <AppNavigator />
    </AuthProvider>
  );
}
