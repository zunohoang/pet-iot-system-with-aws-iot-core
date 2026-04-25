import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions,
} from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { Ionicons } from '@expo/vector-icons';
import { useTelemetry } from '../hooks/useTelemetry';

const WINDOW_WIDTH = Dimensions.get('window').width;

function MetricCard({ icon, label, value, unit, color }) {
  return (
    <View style={[styles.metricCard, { borderLeftColor: color }]}>
      <Ionicons name={icon} size={24} color={color} />
      <Text style={styles.metricValue}>
        {value !== undefined ? `${value}` : '—'}
        <Text style={styles.metricUnit}>{unit}</Text>
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const TIME_OPTIONS = [
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
];

export default function MonitoringScreen({ route }) {
  const { device } = route.params;
  const deviceId   = device.deviceId;

  const { liveData, historyData, lastReading, loadingHist, fetchHistory } =
    useTelemetry(deviceId);

  const [activeRange, setActiveRange] = useState(0);
  const [showLive,    setShowLive]    = useState(true);

  useEffect(() => {
    fetchHistory(TIME_OPTIONS[0].minutes);
  }, [deviceId]);

  const onRangeChange = (index) => {
    setActiveRange(index);
    setShowLive(false);
    fetchHistory(TIME_OPTIONS[index].minutes);
  };

  /* Build chart data points */
  const chartData = (showLive ? liveData : historyData).map(p => ({
    value: p.temperature,
    label: new Date(p.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  }));

  const humidityData = (showLive ? liveData : historyData).map(p => ({
    value: p.humidity,
  }));

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Live Readings */}
      <View style={styles.metricsRow}>
        <MetricCard
          icon="thermometer"
          label="Temperature"
          value={lastReading?.temperature?.toFixed(1)}
          unit="°C"
          color="#f97316"
        />
        <MetricCard
          icon="water"
          label="Humidity"
          value={lastReading?.humidity?.toFixed(1)}
          unit="%"
          color="#0ea5e9"
        />
      </View>

      {/* Chart Header */}
      <View style={styles.chartHeader}>
        <TouchableOpacity onPress={() => setShowLive(true)}>
          <Text style={[styles.liveTab, showLive && styles.activeTab]}>Live</Text>
        </TouchableOpacity>
        <View style={styles.rangeGroup}>
          {TIME_OPTIONS.map((opt, i) => (
            <TouchableOpacity key={opt.label} onPress={() => onRangeChange(i)}>
              <Text style={[styles.rangeTab, !showLive && activeRange === i && styles.activeTab]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Temperature Chart */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>
          <Ionicons name="thermometer" size={14} color="#f97316" /> Temperature (°C)
        </Text>
        {chartData.length > 1 ? (
          <LineChart
            data={chartData}
            width={WINDOW_WIDTH - 64}
            height={160}
            color="#f97316"
            thickness={2}
            hideDataPoints={chartData.length > 20}
            curved
            areaChart
            startFillColor="rgba(249,115,22,0.3)"
            endFillColor="rgba(249,115,22,0)"
            noOfSections={4}
            yAxisColor="#1e293b"
            xAxisColor="#1e293b"
            yAxisTextStyle={{ color: '#64748b', fontSize: 10 }}
            xAxisLabelTextStyle={{ color: '#64748b', fontSize: 9 }}
            hideRules={false}
            rulesColor="#1e293b"
          />
        ) : (
          <View style={styles.noData}>
            <Text style={styles.noDataText}>Waiting for data...</Text>
          </View>
        )}
      </View>

      {/* Humidity Chart */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>
          <Ionicons name="water" size={14} color="#0ea5e9" /> Humidity (%)
        </Text>
        {humidityData.length > 1 ? (
          <LineChart
            data={humidityData}
            width={WINDOW_WIDTH - 64}
            height={160}
            color="#0ea5e9"
            thickness={2}
            hideDataPoints={humidityData.length > 20}
            curved
            areaChart
            startFillColor="rgba(14,165,233,0.3)"
            endFillColor="rgba(14,165,233,0)"
            noOfSections={4}
            yAxisColor="#1e293b"
            xAxisColor="#1e293b"
            yAxisTextStyle={{ color: '#64748b', fontSize: 10 }}
            hideRules={false}
            rulesColor="#1e293b"
          />
        ) : (
          <View style={styles.noData}>
            <Text style={styles.noDataText}>Waiting for data...</Text>
          </View>
        )}
      </View>

      {/* Alert Thresholds Info */}
      <View style={styles.thresholdCard}>
        <Text style={styles.thresholdTitle}>Alert Thresholds</Text>
        <Text style={styles.threshold}>
          <Ionicons name="warning" size={12} color="#f97316" /> Temperature &gt; 35°C → SMS / Push alert
        </Text>
        <Text style={styles.threshold}>
          <Ionicons name="warning" size={12} color="#0ea5e9" /> Humidity &gt; 80% → SMS / Push alert
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0f172a' },
  metricsRow:      { flexDirection: 'row', padding: 16, gap: 12 },
  metricCard:      { flex: 1, backgroundColor: '#1e293b', borderRadius: 14, padding: 16, borderLeftWidth: 4 },
  metricValue:     { fontSize: 28, fontWeight: '700', color: '#f1f5f9', marginTop: 8 },
  metricUnit:      { fontSize: 16, fontWeight: '400', color: '#94a3b8' },
  metricLabel:     { fontSize: 12, color: '#64748b', marginTop: 2 },
  chartHeader:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 8 },
  liveTab:         { fontSize: 13, color: '#64748b', paddingHorizontal: 8, paddingVertical: 4 },
  rangeGroup:      { flexDirection: 'row', gap: 4 },
  rangeTab:        { fontSize: 13, color: '#64748b', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  activeTab:       { color: '#6366f1', backgroundColor: '#1e1b4b', fontWeight: '600' },
  chartCard:       { backgroundColor: '#1e293b', borderRadius: 14, padding: 16, marginHorizontal: 16, marginBottom: 16 },
  chartTitle:      { fontSize: 13, color: '#94a3b8', marginBottom: 12 },
  noData:          { height: 160, justifyContent: 'center', alignItems: 'center' },
  noDataText:      { color: '#334155', fontSize: 14 },
  thresholdCard:   { backgroundColor: '#1e293b', borderRadius: 14, padding: 16, marginHorizontal: 16, marginBottom: 24 },
  thresholdTitle:  { fontSize: 13, color: '#64748b', marginBottom: 8 },
  threshold:       { fontSize: 13, color: '#94a3b8', marginBottom: 4 },
});
