import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listDevices } from '../services/api';
import * as MqttService from '../services/mqtt';
import { useAuth } from '../store/AuthContext';

function DeviceCard({ device, onPress }) {
  const isSwitch = device.deviceType === 'switch' || device.deviceId?.startsWith('switch-');
  const icon     = isSwitch ? 'bulb' : 'thermometer';
  const online   = device.online !== false;

  return (
    <TouchableOpacity style={styles.card} onPress={() => onPress(device)}>
      <View style={[styles.iconWrap, { backgroundColor: online ? '#312e81' : '#1e293b' }]}>
        <Ionicons name={icon} size={26} color={online ? '#818cf8' : '#475569'} />
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.deviceId}>{device.deviceId}</Text>
        <Text style={styles.deviceType}>{isSwitch ? 'Light Switch' : 'DHT11 Sensor'}</Text>
        {device.lastTemperature !== undefined && (
          <Text style={styles.metric}>
            {device.lastTemperature}°C · {device.lastHumidity}%
          </Text>
        )}
      </View>
      <View style={[styles.onlineDot, { backgroundColor: online ? '#22c55e' : '#ef4444' }]} />
    </TouchableOpacity>
  );
}

export default function DashboardScreen({ navigation }) {
  const { user, logout } = useAuth();
  const [devices,     setDevices]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [mqttReady,   setMqttReady]   = useState(false);

  /* Connect MQTT once on mount */
  useEffect(() => {
    const clientId = `mobile-${user?.userId?.slice(0, 8) || Date.now()}`;
    const offStatus = MqttService.onConnectionStatusChange((connected) => {
      setMqttReady(connected);
    });

    MqttService.connect(clientId)
      .catch(err => console.error('[MQTT] Connect failed:', err));

    return () => {
      offStatus?.();
      MqttService.disconnect();
    };
  }, []);

  /* Subscribe to live device status updates */
  useEffect(() => {
    if (!mqttReady) return;
    const unsub = MqttService.subscribe('devices/+/status', (topic, data) => {
      const deviceId = topic.split('/')[1];
      setDevices(prev => prev.map(d =>
        d.deviceId === deviceId ? { ...d, ...data } : d
      ));
    });
    return () => unsub?.();
  }, [mqttReady]);

  const loadDevices = useCallback(async () => {
    try {
      const list = await listDevices();
      console.log('[dashboard] listDevices result', {
        count: Array.isArray(list) ? list.length : -1,
        deviceIds: Array.isArray(list) ? list.map(d => d.deviceId) : [],
      });
      setDevices(list);
    } catch (err) {
      console.error('[dashboard] listDevices failed', {
        message: err?.message,
        name: err?.name,
      });
      Alert.alert('Error', err?.message || 'Failed to load devices');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadDevices(); }, [loadDevices]));

  const onRefresh = () => { setRefreshing(true); loadDevices(); };

  const onDevicePress = (device) => {
    const isSwitch = device.deviceType === 'switch' || device.deviceId?.startsWith('switch-');
    if (isSwitch) {
      navigation.navigate('DeviceControl', { device });
    } else {
      navigation.navigate('Monitoring', { device });
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Welcome back</Text>
          <Text style={styles.email}>{user?.email || 'User'}</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => navigation.navigate('AddDevice')}
            style={styles.headerIconBtn}
            accessibilityLabel="Add device"
          >
            <Ionicons name="add-circle-outline" size={26} color="#94a3b8" />
          </TouchableOpacity>
          <TouchableOpacity onPress={logout} style={styles.headerIconBtn}>
            <Ionicons name="log-out-outline" size={22} color="#94a3b8" />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.statusBar}>
        <View style={[styles.mqttDot, { backgroundColor: mqttReady ? '#22c55e' : '#f59e0b' }]} />
        <Text style={styles.mqttText}>{mqttReady ? 'Live' : 'Connecting...'}</Text>
        <Text style={styles.deviceCount}>{devices.length} device{devices.length !== 1 ? 's' : ''}</Text>
      </View>

      <FlatList
        data={devices}
        keyExtractor={d => d.deviceId}
        renderItem={({ item }) => (
          <DeviceCard device={item} onPress={onDevicePress} />
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
            tintColor="#6366f1" />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="hardware-chip-outline" size={48} color="#334155" />
            <Text style={styles.emptyText}>No devices found</Text>
            <Text style={styles.emptySubtext}>Register a device to get started</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0f172a' },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  header:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 16 },
  greeting:    { fontSize: 13, color: '#64748b' },
  email:       { fontSize: 18, fontWeight: '700', color: '#f1f5f9' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  headerIconBtn:   { padding: 8 },
  statusBar:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 8 },
  mqttDot:     { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  mqttText:    { fontSize: 12, color: '#94a3b8', flex: 1 },
  deviceCount: { fontSize: 12, color: '#475569' },
  list:        { padding: 16, paddingTop: 8 },
  card:        { backgroundColor: '#1e293b', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  iconWrap:    { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  cardBody:    { flex: 1 },
  deviceId:    { fontSize: 15, fontWeight: '600', color: '#f1f5f9' },
  deviceType:  { fontSize: 12, color: '#64748b', marginTop: 2 },
  metric:      { fontSize: 13, color: '#818cf8', marginTop: 4 },
  onlineDot:   { width: 10, height: 10, borderRadius: 5, marginLeft: 8 },
  empty:       { alignItems: 'center', marginTop: 80 },
  emptyText:   { fontSize: 18, fontWeight: '600', color: '#475569', marginTop: 16 },
  emptySubtext: { fontSize: 13, color: '#334155', marginTop: 6 },
});
