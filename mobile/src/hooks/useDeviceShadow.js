/**
 * useDeviceShadow
 *
 * Subscribes to a device's shadow via MQTT and provides:
 * - reportedState: the current state the device has confirmed
 * - desiredState:  the state we want the device to be in
 * - updateDesired: function to send a new desired state
 * - isOnline:      whether the device is currently connected
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as MqttService from '../services/mqtt';
import { updateDeviceShadow } from '../services/api';

export function useDeviceShadow(deviceId, initialOnline = false) {
  const [reportedState, setReportedState] = useState(null);
  const [desiredState,  setDesiredState]  = useState(null);
  const [isOnline,      setIsOnline]      = useState(initialOnline);
  const [loading,       setLoading]       = useState(true);
  const [shadowError,   setShadowError]   = useState(null);
  const unsubRefs = useRef([]);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setLoading(true);
    setShadowError(null);
    const loadingTimer = setTimeout(() => {
      if (cancelled) return;
      setLoading(false);
      setShadowError((prev) => prev || { message: 'Timed out waiting for device shadow response' });
    }, 8000);

    const shadowAcceptedTopic = `$aws/things/${deviceId}/shadow/get/accepted`;
    const shadowRejectedTopic = `$aws/things/${deviceId}/shadow/get/rejected`;
    const shadowUpdateTopic = `$aws/things/${deviceId}/shadow/update/accepted`;
    const shadowUpdateRejectedTopic = `$aws/things/${deviceId}/shadow/update/rejected`;
    const statusTopic = `devices/${deviceId}/status`;

    const unsubShadowGet = MqttService.subscribe(shadowAcceptedTopic, (_, data) => {
      console.log('[MQTT] shadow get accepted', data);
      if (data?.state) {
        setReportedState(data.state.reported || null);
        setDesiredState(data.state.desired   || null);
        setShadowError(null);
        setLoading(false);
      }
    });

    const unsubShadowGetRejected = MqttService.subscribe(shadowRejectedTopic, (_, data) => {
      console.warn('[MQTT] Shadow get rejected:', data);
      setShadowError(data || { message: 'Shadow get rejected' });
      setLoading(false);
    });

    const unsubShadowUpdate = MqttService.subscribe(shadowUpdateTopic, (_, data) => {
      console.log('[MQTT] shadow update accepted', data);
      if (data?.state) {
        if (data.state.reported) setReportedState(prev => ({ ...prev, ...data.state.reported }));
        if (data.state.desired)  setDesiredState(prev  => ({ ...prev, ...data.state.desired }));
      }
    });

    const unsubShadowUpdateRejected = MqttService.subscribe(shadowUpdateRejectedTopic, (_, data) => {
      console.warn('[MQTT] Shadow update rejected:', data);
      setShadowError(data || { message: 'Shadow update rejected' });
    });

    const unsubStatus = MqttService.subscribe(statusTopic, (_, data) => {
      console.log('[MQTT] status topic message:', data);
      if (data?.online !== undefined) setIsOnline(Boolean(data.online));
      if (data?.relay !== undefined) {
        setReportedState(prev => ({ ...prev, relay: data.relay }));
      }
    });
    const unsubConn = MqttService.onConnectionStatusChange((connected) => {
      if (connected) {
        MqttService.publish(`$aws/things/${deviceId}/shadow/get`, '{}');
        return;
      }
      if (!connected) {
        setLoading(false);
        setShadowError((prev) => prev || { message: 'MQTT disconnected' });
      }
    });

    if (unsubShadowGet)    unsubRefs.current.push(unsubShadowGet);
    if (unsubShadowGetRejected) unsubRefs.current.push(unsubShadowGetRejected);
    if (unsubShadowUpdate) unsubRefs.current.push(unsubShadowUpdate);
    if (unsubShadowUpdateRejected) unsubRefs.current.push(unsubShadowUpdateRejected);
    if (unsubStatus)       unsubRefs.current.push(unsubStatus);
    if (unsubConn)         unsubRefs.current.push(unsubConn);

    MqttService.connect(`mobile-shadow-${deviceId.slice(-12)}`)
      .catch((err) => {
        console.warn('[MQTT] connect failed in useDeviceShadow:', err?.message || err);
        if (!cancelled) {
          setLoading(false);
          setShadowError((prev) => prev || { message: 'Failed to connect MQTT' });
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(loadingTimer);
      unsubRefs.current.forEach(fn => fn?.());
      unsubRefs.current = [];
    };
  }, [deviceId]);

  const updateDesired = useCallback(async (newState) => {
    setDesiredState(prev => ({ ...prev, ...newState }));
    await updateDeviceShadow(deviceId, newState);
  }, [deviceId]);

  return { reportedState, desiredState, isOnline, loading, shadowError, updateDesired };
}
