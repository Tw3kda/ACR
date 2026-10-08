import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native';

import { useAuth } from '@/store/authStore';

/**
 * "Cerrar sesión", in the header of the consent list. Asks first: on a shared
 * tablet a stray tap would otherwise send the professional back to the login
 * screen in front of a patient.
 */
export function LogoutButton() {
  const { logout } = useAuth();

  const confirmLogout = () => {
    const message = '¿Cerrar la sesión en esta tablet?';
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(message)) logout();
      return;
    }
    Alert.alert('Cerrar sesión', message, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Cerrar sesión', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <Pressable onPress={confirmLogout} accessibilityRole="button" hitSlop={8} style={styles.button}>
      <Text style={styles.text}>Cerrar sesión</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 8, paddingVertical: 6 },
  text: { color: '#b42318', fontWeight: '600', fontSize: 15 },
});
