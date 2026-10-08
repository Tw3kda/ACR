import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { shareConsentPdf } from '@/features/consent/services/pdfService';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';

/**
 * How filing fared. Shown because a consent that has not reached the backend
 * is a compliance gap, not a silent detail. `queued` is not a failure: the
 * consent is on disk and goes out on its own when there is a connection.
 */
const SUBMISSION_LABEL: Record<string, string> = {
  sent: 'Consentimiento registrado y verificado en el servidor',
  queued: 'Sin conexión: guardado en el dispositivo, se enviará automáticamente',
  rejected: 'El servidor rechazó el consentimiento',
  skipped: 'No enviado (sin archivo local en esta plataforma)',
};

export default function ConsentDoneScreen() {
  const router = useRouter();
  const { template, generatedPdfUri, submission, reset, decision } = useConsentDraft();
  const declined = decision === 'decline';
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setError(null);
    try {
      // Phase 1: hand the local file to the OS share sheet. Phase 2 replaces
      // this with an upload through StorageService and a presigned URL.
      await shareConsentPdf(generatedPdfUri ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo compartir el documento');
    }
  }

  function handleFinish() {
    reset();
    router.dismissTo('/(app)/consent');
  }

  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeMark}>✓</Text>
      </View>

      <Text style={styles.title}>{declined ? 'Rechazo firmado' : 'Consentimiento firmado'}</Text>
      <Text style={styles.body}>
        {template ? `${template.code} · Versión ${template.version}` : 'Documento generado'} —{' '}
        {declined ? 'el paciente NO autorizó el procedimiento. ' : ''}Firmado por el paciente y por el
        profesional.
      </Text>

      {submission ? (
        <Text style={submission.status === 'sent' ? styles.auditOk : styles.auditPending}>
          {SUBMISSION_LABEL[submission.status]}
          {submission.detail ? ` · ${submission.detail}` : ''}
        </Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          label="Descargar / compartir PDF"
          onPress={handleDownload}
          disabled={!generatedPdfUri}
        />
        <Button label="Finalizar" onPress={handleFinish} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
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
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 8 },
  auditOk: { fontSize: 12, color: '#0b5f66', textAlign: 'center' },
  auditPending: { fontSize: 12, color: '#8a6d3b', textAlign: 'center' },
  error: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
});
