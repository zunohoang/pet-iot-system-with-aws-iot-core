/**
 * useTelemetry
 *
 * Listens to live MQTT telemetry AND can fetch historical data from Timestream.
 */

import { useState, useEffect, useRef } from 'react';
import * as MqttService from '../services/mqtt';
import { getTelemetry } from '../services/api';

const MAX_LIVE_POINTS = 50;

export function useTelemetry(deviceId) {
  const [liveData,     setLiveData]     = useState([]);
  const [historyData,  setHistoryData]  = useState([]);
  const [lastReading,  setLastReading]  = useState(null);
  const [loadingHist,  setLoadingHist]  = useState(false);
  const unsubRef = useRef(null);

  useEffect(() => {
    if (!deviceId) return;

    const topic = `devices/${deviceId}/telemetry`;

    unsubRef.current = MqttService.subscribe(topic, (_, data) => {
      const point = {
        timestamp:   Date.now(),
        temperature: data.temperature,
        humidity:    data.humidity,
      };
      setLastReading(point);
      setLiveData(prev => {
        const next = [...prev, point];
        return next.length > MAX_LIVE_POINTS ? next.slice(-MAX_LIVE_POINTS) : next;
      });
    });

    return () => unsubRef.current?.();
  }, [deviceId]);

  const fetchHistory = async (minutes = 60) => {
    if (!deviceId) return;
    setLoadingHist(true);
    try {
      const rows = await getTelemetry(deviceId, minutes);
      /* rows: [{time, measure, value}] — group into {time, temperature, humidity} */
      const grouped = {};
      rows.forEach(({ time, measure, value }) => {
        if (!grouped[time]) grouped[time] = { timestamp: new Date(time).getTime() };
        grouped[time][measure] = value;
      });
      setHistoryData(Object.values(grouped).sort((a, b) => a.timestamp - b.timestamp));
    } finally {
      setLoadingHist(false);
    }
  };

  return { liveData, historyData, lastReading, loadingHist, fetchHistory };
}
