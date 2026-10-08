import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { KeyboardAvoidingScreen } from '@/components/common/KeyboardAvoidingScreen';
import { Button } from '@/components/ui/Button';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { useLogin } from '@/features/auth/hooks/useLogin';

export default function LoginScreen() {
  const router = useRouter();
  const { submit, isSubmitting, error } = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit() {
    const ok = await submit(email, password);
    if (ok) {
      router.replace('/(app)/consent');
    }
  }

  return (
    <KeyboardAvoidingScreen>
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Iniciar sesión</Text>

      <TextInput
        style={styles.inputField}
        placeholder="Correo"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        editable={!isSubmitting}
      />
      <PasswordInput
        placeholder="Contraseña"
        value={password}
        onChangeText={setPassword}
        editable={!isSubmitting}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isSubmitting ? (
        <ActivityIndicator />
      ) : (
        <Button label="Iniciar sesión" onPress={handleSubmit} disabled={!email || !password} />
      )}

      <Link href="/(auth)/register">¿No tienes cuenta? Regístrate</Link>
    </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  inputField: {
    width: '100%',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  error: {
    color: '#dc2626',
  },
});
