import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { signIn, signUp, confirmSignUp } from '../services/auth';
import { useAuth } from '../store/AuthContext';

export default function LoginScreen() {
  const { login } = useAuth();
  const [mode, setMode] = useState('signin'); // signin | signup | confirm
  const [username,  setUsername]  = useState('');
  const [email,     setEmail]     = useState('');
  const [password,  setPassword]  = useState('');
  const [code,      setCode]      = useState('');
  const [pendingUsername, setPendingUsername] = useState('');
  const [loading,   setLoading]   = useState(false);

  const handleLogin = async () => {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername || !password) {
      Alert.alert('Error', 'Please enter username and password');
      return;
    }
    setLoading(true);
    try {
      const tokens = await signIn(normalizedUsername, password);
      login(tokens);
    } catch (err) {
      Alert.alert('Login Failed', err.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async () => {
    const normalizedUsername = username.trim().toLowerCase();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedUsername || !normalizedEmail || !password) {
      Alert.alert('Error', 'Please enter username, email, and password');
      return;
    }
    setLoading(true);
    try {
      await signUp(normalizedUsername, password, normalizedEmail);
      setPendingUsername(normalizedUsername);
      setMode('confirm');
      Alert.alert('Verify account', 'A confirmation code was sent to your email.');
    } catch (err) {
      Alert.alert('Sign Up Failed', err.message || 'Cannot create account');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    const finalUsername = (pendingUsername || username).trim().toLowerCase();
    if (!finalUsername || !code.trim()) {
      Alert.alert('Error', 'Please enter username and confirmation code');
      return;
    }
    setLoading(true);
    try {
      await confirmSignUp(finalUsername, code.trim());
      Alert.alert('Success', 'Account verified. Please sign in.');
      setMode('signin');
      setCode('');
    } catch (err) {
      Alert.alert('Verification Failed', err.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <Text style={styles.title}>IoT Smart Home</Text>
        <Text style={styles.subtitle}>
          {mode === 'signin' && 'Sign in to your account'}
          {mode === 'signup' && 'Create a new account'}
          {mode === 'confirm' && 'Confirm your email code'}
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Username (lowercase)"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          value={username}
          onChangeText={setUsername}
        />
        {mode === 'signup' && (
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
        )}
        {mode === 'confirm' && (
          <TextInput
            style={styles.input}
            placeholder="Confirmation code"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            keyboardType="number-pad"
            value={code}
            onChangeText={setCode}
          />
        )}
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#64748b"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={
            mode === 'signin'
              ? handleLogin
              : mode === 'signup'
                ? handleSignUp
                : handleConfirm
          }
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : (
              <Text style={styles.buttonText}>
                {mode === 'signin' && 'Sign In'}
                {mode === 'signup' && 'Create Account'}
                {mode === 'confirm' && 'Confirm Account'}
              </Text>
            )
          }
        </TouchableOpacity>

        <View style={styles.switchRow}>
          {mode !== 'signin' && (
            <TouchableOpacity onPress={() => setMode('signin')}>
              <Text style={styles.switchText}>Already have an account? Sign in</Text>
            </TouchableOpacity>
          )}
          {mode === 'signin' && (
            <TouchableOpacity onPress={() => setMode('signup')}>
              <Text style={styles.switchText}>No account? Create one</Text>
            </TouchableOpacity>
          )}
          {mode === 'signup' && (
            <TouchableOpacity onPress={() => setMode('confirm')}>
              <Text style={styles.switchText}>Have a code? Confirm account</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 28,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#f1f5f9',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginBottom: 28,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
    color: '#f1f5f9',
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  button: {
    backgroundColor: '#6366f1',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 6,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  switchRow: {
    marginTop: 16,
    alignItems: 'center',
  },
  switchText: {
    color: '#a5b4fc',
    fontSize: 13,
  },
});
