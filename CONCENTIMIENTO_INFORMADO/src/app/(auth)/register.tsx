import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput } from 'react-native';

import { KeyboardAvoidingScreen } from '@/components/common/KeyboardAvoidingScreen';
import { Button } from '@/components/ui/Button';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { useRegister } from '@/features/auth/hooks/useRegister';

export default function RegisterScreen() {
  const router = useRouter();
  const { submit, isSubmitting, error } = useRegister();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmit = Boolean(name && email && passwordsMatch) && !isSubmitting;

  async function handleSubmit() {
    if (!passwordsMatch) return;
    const ok = await submit(name, email, password);
    if (ok) {
      router.replace('/(app)/consent');
    }
  }

  return (
    <KeyboardAvoidingScreen>
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Crear cuenta</Text>

      <TextInput
        style={styles.inputField}
        placeholder="Nombre completo"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        editable={!isSubmitting}
      />
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
      <PasswordInput
        placeholder="Confirmar contraseña"
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        editable={!isSubmitting}
      />

      {!passwordsMatch && confirmPassword.length > 0 ? (
        <Text style={styles.error}>Las contraseñas no coinciden</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isSubmitting ? (
        <ActivityIndicator />
      ) : (
        <Button label="Registrarme" onPress={handleSubmit} disabled={!canSubmit} />
      )}

      <Link href="/(auth)/login">¿Ya tienes cuenta? Inicia sesión</Link>
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
