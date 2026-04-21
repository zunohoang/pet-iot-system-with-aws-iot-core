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

export function useDeviceShadow(deviceId) {
  const [reportedState, setReportedState] = useState(null);
  const [desiredState,  setDesiredState]  = useState(null);
  const [isOnline,      setIsOnline]      = useState(false);
  const [loading,       setLoading]       = useState(true);
  const unsubRefs = useRef([]);

  useEffect(() => {
    if (!deviceId) return;

    const shadowAcceptedTopic = `$aws/things/${deviceId}/shadow/get/accepted`;
    const shadowUpdateTopic   = `$aws/things/${deviceId}/shadow/update/accepted`;
    const statusTopic         = `devices/${deviceId}/status`;

    /* Request current shadow state */
    MqttService.publish(`$aws/things/${deviceId}/shadow/get`, '{}');

    const unsubShadowGet = MqttService.subscribe(shadowAcceptedTopic, (_, data) => {
      if (data?.state) {
        setReportedState(data.state.reported || null);
        setDesiredState(data.state.desired   || null);
        setLoading(false);
      }
    });

    const unsubShadowUpdate = MqttService.subscribe(shadowUpdateTopic, (_, data) => {
      if (data?.state) {
        if (data.state.reported) setReportedState(prev => ({ ...prev, ...data.state.reported }));
        if (data.state.desired)  setDesiredState(prev  => ({ ...prev, ...data.state.desired }));
      }
    });

    const unsubStatus = MqttService.subscribe(statusTopic, (_, data) => {
      if (data?.online !== undefined) setIsOnline(Boolean(data.online));
    });

    if (unsubShadowGet)    unsubRefs.current.push(unsubShadowGet);
    if (unsubShadowUpdate) unsubRefs.current.push(unsubShadowUpdate);
    if (unsubStatus)       unsubRefs.current.push(unsubStatus);

    return () => {
      unsubRefs.current.forEach(fn => fn?.());
      unsubRefs.current = [];
    };
  }, [deviceId]);

  const updateDesired = useCallback(async (newState) => {
    setDesiredState(prev => ({ ...prev, ...newState }));
    await updateDeviceShadow(deviceId, newState);
  }, [deviceId]);

  return { reportedState, desiredState, isOnline, loading, updateDesired };
}
