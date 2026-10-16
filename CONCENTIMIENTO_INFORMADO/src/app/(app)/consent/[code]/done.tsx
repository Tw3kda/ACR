import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { shareConsentPdf } from '@/features/consent/services/pdfService';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';

/**
 * How filing fared, per document. Shown because a consent that has not
 * reached the backend is a compliance gap, not a silent detail. `queued` is
 * not a failure: the consent is on disk and goes out on its own when there is
 * a connection.
 */
const SUBMISSION_LABEL: Record<string, string> = {
  sent: 'Registrado y verificado en el servidor',
  queued: 'Sin conexión: guardado en el dispositivo, se enviará automáticamente',
  rejected: 'El servidor rechazó el consentimiento',
  skipped: 'No enviado (sin archivo local en esta plataforma)',
};

export default function ConsentDoneScreen() {
  const router = useRouter();
  const { templates, generatedPdfUris, submissions, reset, decision } = useConsentDraft();
  const declined = decision === 'decline';
  const isBatch = templates.length > 1;
  const [error, setError] = useState<string | null>(null);

  async function handleShare(uri: string | null) {
    setError(null);
    try {
      await shareConsentPdf(uri ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo compartir el documento');
    }
  }

  function handleFinish() {
    reset();
    router.dismissTo('/(app)/consent');
  }

  const title = declined
    ? isBatch
      ? 'Rechazos firmados'
      : 'Rechazo firmado'
    : isBatch
      ? 'Consentimientos firmados'
      : 'Consentimiento firmado';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeMark}>✓</Text>
      </View>

      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>
        {declined ? 'El paciente NO autorizó los procedimientos. ' : ''}
        {isBatch
          ? `${templates.length} documentos firmados por el paciente y por el profesional, un PDF por cada uno.`
          : 'Firmado por el paciente y por el profesional.'}
      </Text>

      <View style={styles.documents}>
        {templates.map((form, index) => {
          const submission = submissions[index];
          const uri = generatedPdfUris[index] ?? null;
          return (
            <View key={form.code} style={styles.document}>
              <Text style={styles.documentTitle}>
                {form.code} · Versión {form.version}
              </Text>
              <Text style={styles.documentName}>{form.title}</Text>
              <Text
                style={
                  submission?.status === 'sent' ? styles.auditOk : styles.auditPending
                }
              >
                {submission
                  ? `${SUBMISSION_LABEL[submission.status]}${submission.detail ? ` · ${submission.detail}` : ''}`
                  : 'Enviando al servidor…'}
              </Text>
              <Pressable
                onPress={() => handleShare(uri)}
                disabled={!uri}
                hitSlop={6}
                style={styles.shareButton}
              >
                <Text style={[styles.shareLabel, !uri && styles.shareDisabled]}>
                  Descargar / compartir PDF
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button label="Finalizar" onPress={handleFinish} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
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
  documents: { alignSelf: 'stretch', gap: 10 },
  document: {
    borderWidth: 1,
    borderColor: '#d7e1e1',
    borderRadius: 10,
    backgroundColor: '#fff',
    padding: 14,
    gap: 4,
  },
  documentTitle: { fontSize: 14, fontWeight: '700', color: '#12212b' },
  documentName: { fontSize: 13, color: '#4e6870' },
  shareButton: { alignSelf: 'flex-start', paddingTop: 6 },
  shareLabel: { color: '#0e7a82', fontWeight: '600', fontSize: 14 },
  shareDisabled: { color: '#9fb4b4' },
  actions: { alignSelf: 'stretch', gap: 10, marginTop: 8 },
  auditOk: { fontSize: 12, color: '#0b5f66' },
  auditPending: { fontSize: 12, color: '#8a6d3b' },
  error: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
});
