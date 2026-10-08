import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';

/**
 * The seam between the two signers. The patient has confirmed and is done;
 * everything past this screen is the professional's part of the flow.
 */
export default function ConsentHandoffScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { template } = useConsentDraft();

  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeMark}>✓</Text>
      </View>

      <Text style={styles.title}>Consentimiento diligenciado</Text>
      <Text style={styles.body}>
        Sus datos y su firma quedaron registrados
        {template ? ` en el documento ${template.code}` : ''}.
      </Text>

      <View style={styles.instruction}>
        <Text style={styles.instructionText}>
          Por favor entregue el dispositivo al profesional que le atiende para completar la firma.
        </Text>
      </View>

      <Button
        label="Continuar a la firma del profesional"
        onPress={() =>
          router.replace({ pathname: '/(app)/consent/[code]/professional', params: { code } })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 14,
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#dceeee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeMark: { fontSize: 30, color: '#0b5f66', fontWeight: '700' },
  title: { fontSize: 20, fontWeight: '700', color: '#12212b', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 21, color: '#4e6870', textAlign: 'center' },
  instruction: {
    backgroundColor: '#f3e4d2',
    borderRadius: 8,
    padding: 14,
    marginVertical: 6,
  },
  instructionText: {
    fontSize: 15,
    lineHeight: 22,
    color: '#12212b',
    textAlign: 'center',
    fontWeight: '600',
  },
});
