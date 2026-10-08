import { Stack } from 'expo-router';

import { LogoutButton } from '@/components/ui/LogoutButton';
import { ConsentDraftProvider } from '@/features/consent/store/consentDraftStore';

export default function ConsentLayout() {
  return (
    <ConsentDraftProvider>
      <Stack>
        <Stack.Screen
          name="index"
          options={{ title: 'Consentimientos', headerRight: () => <LogoutButton /> }}
        />
        <Stack.Screen name="[code]" options={{ headerShown: false }} />
      </Stack>
    </ConsentDraftProvider>
  );
}
