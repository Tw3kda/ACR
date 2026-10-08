import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { flushPendingConsents } from '@/features/consent/services/consentSubmitService';
import { useAuth } from '@/store/authStore';

/**
 * Consents that could not be filed wait on disk. They go out when the app
 * opens with a session, and every time it comes back to the foreground —
 * which is when a tablet that was offline is most likely to have a network
 * again. Both need the token to be set, hence living under the (app) group.
 */
function useOutboxFlush(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    void flushPendingConsents();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void flushPendingConsents();
    });
    return () => subscription.remove();
  }, [enabled]);
}

export default function AppLayout() {
  const { token, isLoading } = useAuth();
  useOutboxFlush(Boolean(token));

  if (isLoading) return null;
  if (!token) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
 
      <Stack.Screen name="settings" options={{ headerShown: true }} />
      <Stack.Screen name="consent" />
    </Stack>
  );
}
