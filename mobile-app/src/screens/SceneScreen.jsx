import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Modal, TextInput, Switch, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listScenes, createScene, updateScene, deleteScene, runScene } from '../services/api';
import { useAuth } from '../store/AuthContext';

function SceneCard({ scene, onRun, onToggle, onDelete }) {
  const triggerLabel = scene.trigger?.type === 'schedule'
    ? `Schedule: ${scene.trigger.cron || ''}`
    : scene.trigger?.type === 'threshold'
    ? `Threshold: ${scene.trigger.condition || ''}`
    : 'Manual';

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.cardLeft}>
          <Text style={styles.sceneName}>{scene.name}</Text>
          <Text style={styles.trigger}>{triggerLabel}</Text>
          <Text style={styles.actions}>{scene.actions?.length || 0} action(s)</Text>
        </View>
        <View style={styles.cardRight}>
          <Switch
            value={scene.enabled === 'true' || scene.enabled === true}
            onValueChange={(val) => onToggle(scene, val)}
            thumbColor={scene.enabled === 'true' ? '#6366f1' : '#475569'}
            trackColor={{ false: '#1e293b', true: '#312e81' }}
          />
        </View>
      </View>
      <View style={styles.cardActions}>
        <TouchableOpacity style={styles.runBtn} onPress={() => onRun(scene)}>
          <Ionicons name="play" size={14} color="#22c55e" />
          <Text style={styles.runText}>Run Now</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteBtn} onPress={() => onDelete(scene)}>
          <Ionicons name="trash-outline" size={16} color="#ef4444" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CreateSceneModal({ visible, onClose, onCreated }) {
  const { user } = useAuth();
  const [name,       setName]       = useState('');
  const [deviceId,   setDeviceId]   = useState('');
  const [state,      setState]      = useState('OFF');
  const [triggerType, setTriggerType] = useState('manual');
  const [cronExpr,   setCronExpr]   = useState('0 22 * * *');
  const [saving,     setSaving]     = useState(false);

  const save = async () => {
    if (!name.trim() || !deviceId.trim()) {
      Alert.alert('Validation', 'Name and Device ID are required');
      return;
    }
    setSaving(true);
    try {
      const trigger = triggerType === 'schedule'
        ? { type: 'schedule', cron: cronExpr, scheduleName: name }
        : { type: 'manual' };

      await createScene({
        name: name.trim(),
        trigger,
        actions: [{ deviceId: deviceId.trim(), state: { relay: state } }],
        enabled: true,
      });
      onCreated();
      onClose();
      setName(''); setDeviceId(''); setState('OFF');
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>New Scene</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#94a3b8" />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody}>
          <Text style={styles.fieldLabel}>Scene Name</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName}
            placeholder="e.g. Night Mode" placeholderTextColor="#475569" />

          <Text style={styles.fieldLabel}>Target Device ID</Text>
          <TextInput style={styles.input} value={deviceId} onChangeText={setDeviceId}
            placeholder="switch-AABBCCDDEE" placeholderTextColor="#475569"
            autoCapitalize="none" />

          <Text style={styles.fieldLabel}>Relay Action</Text>
          <View style={styles.stateRow}>
            {['ON', 'OFF'].map(s => (
              <TouchableOpacity key={s}
                style={[styles.stateBtn, state === s && styles.stateBtnActive]}
                onPress={() => setState(s)}
              >
                <Text style={[styles.stateBtnText, state === s && styles.stateBtnTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Trigger Type</Text>
          <View style={styles.stateRow}>
            {['manual', 'schedule'].map(t => (
              <TouchableOpacity key={t}
                style={[styles.stateBtn, triggerType === t && styles.stateBtnActive]}
                onPress={() => setTriggerType(t)}
              >
                <Text style={[styles.stateBtnText, triggerType === t && styles.stateBtnTextActive]}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {triggerType === 'schedule' && (
            <>
              <Text style={styles.fieldLabel}>Cron Expression (UTC)</Text>
              <TextInput style={styles.input} value={cronExpr} onChangeText={setCronExpr}
                placeholder="0 22 * * *" placeholderTextColor="#475569"
                autoCapitalize="none" />
              <Text style={styles.hint}>e.g. 0 15 * * * = 22:00 UTC+7 every day</Text>
            </>
          )}
        </ScrollView>

        <TouchableOpacity
          style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
          onPress={save} disabled={saving}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.saveBtnText}>Create Scene</Text>
          }
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

export default function SceneScreen() {
  const [scenes,       setScenes]       = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [showCreate,   setShowCreate]   = useState(false);

  const load = async () => {
    try {
      const list = await listScenes();
      setScenes(list);
    } catch (err) {
      Alert.alert('Error', 'Failed to load scenes');
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, []));

  const handleRun = async (scene) => {
    try {
      await runScene(scene.sceneId);
      Alert.alert('Success', `Scene "${scene.name}" triggered`);
    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  const handleToggle = async (scene, enabled) => {
    try {
      await updateScene(scene.sceneId, { enabled });
      setScenes(prev => prev.map(s =>
        s.sceneId === scene.sceneId ? { ...s, enabled: String(enabled) } : s
      ));
    } catch {}
  };

  const handleDelete = (scene) => {
    Alert.alert('Delete Scene', `Are you sure you want to delete "${scene.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await deleteScene(scene.sceneId);
            setScenes(prev => prev.filter(s => s.sceneId !== scene.sceneId));
          } catch (err) {
            Alert.alert('Error', err.message);
          }
        },
      },
    ]);
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
        <Text style={styles.headerTitle}>Smart Scenes</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowCreate(true)}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <FlatList
        data={scenes}
        keyExtractor={s => s.sceneId}
        renderItem={({ item }) => (
          <SceneCard
            scene={item}
            onRun={handleRun}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        )}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="flash-outline" size={48} color="#334155" />
            <Text style={styles.emptyText}>No scenes yet</Text>
            <Text style={styles.emptySubtext}>Tap + to create your first automation</Text>
          </View>
        }
      />

      <CreateSceneModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={load}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container:         { flex: 1, backgroundColor: '#0f172a' },
  center:            { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  header:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20 },
  headerTitle:       { fontSize: 22, fontWeight: '700', color: '#f1f5f9' },
  addBtn:            { backgroundColor: '#6366f1', width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  list:              { padding: 16, paddingTop: 0 },
  card:              { backgroundColor: '#1e293b', borderRadius: 14, padding: 16, marginBottom: 12 },
  cardTop:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  cardLeft:          { flex: 1 },
  cardRight:         { marginLeft: 12 },
  sceneName:         { fontSize: 16, fontWeight: '600', color: '#f1f5f9', marginBottom: 4 },
  trigger:           { fontSize: 12, color: '#64748b', marginBottom: 2 },
  actions:           { fontSize: 12, color: '#475569' },
  cardActions:       { flexDirection: 'row', alignItems: 'center', gap: 12 },
  runBtn:            { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#052e16', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  runText:           { fontSize: 13, color: '#22c55e', fontWeight: '500' },
  deleteBtn:         { padding: 8 },
  empty:             { alignItems: 'center', marginTop: 80 },
  emptyText:         { fontSize: 18, fontWeight: '600', color: '#475569', marginTop: 16 },
  emptySubtext:      { fontSize: 13, color: '#334155', marginTop: 6 },
  modal:             { flex: 1, backgroundColor: '#0f172a' },
  modalHeader:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#1e293b' },
  modalTitle:        { fontSize: 18, fontWeight: '700', color: '#f1f5f9' },
  modalBody:         { padding: 20, flex: 1 },
  fieldLabel:        { fontSize: 13, color: '#94a3b8', marginBottom: 6, marginTop: 14 },
  input:             { backgroundColor: '#1e293b', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: '#f1f5f9', borderWidth: 1, borderColor: '#334155' },
  stateRow:          { flexDirection: 'row', gap: 10 },
  stateBtn:          { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1e293b', alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  stateBtnActive:    { backgroundColor: '#312e81', borderColor: '#6366f1' },
  stateBtnText:      { fontSize: 14, color: '#475569', fontWeight: '500' },
  stateBtnTextActive: { color: '#a5b4fc' },
  hint:              { fontSize: 11, color: '#475569', marginTop: 4 },
  saveBtn:           { backgroundColor: '#6366f1', margin: 20, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  saveBtnDisabled:   { opacity: 0.6 },
  saveBtnText:       { color: '#fff', fontSize: 16, fontWeight: '600' },
});
