import { Stack } from 'expo-router';

/**
 * The signing flow, in order:
 * index → preview → handoff → professional → done
 *
 * `handoff` onward have no back button: once the patient has confirmed, the
 * document should not be silently edited behind their back.
 */
export default function ConsentFlowLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Diligenciar' }} />
      <Stack.Screen name="preview" options={{ title: 'Revisar documento' }} />
      <Stack.Screen
        name="handoff"
        options={{ title: 'Entregar dispositivo', headerBackVisible: false, gestureEnabled: false }}
      />
      <Stack.Screen
        name="professional"
        options={{ title: 'Firma del profesional', headerBackVisible: false, gestureEnabled: false }}
      />
      <Stack.Screen
        name="done"
        options={{ title: 'Documento firmado', headerBackVisible: false, gestureEnabled: false }}
      />
    </Stack>
  );
}
