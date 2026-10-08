import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { SignaturePad } from '@/components/ui/SignaturePad';
import { buildConsentSignedLog } from '@/features/audit/services/auditLogBuilder';
import { buildConsentHtml } from '@/features/consent/services/documentHtml';
import { generateConsentPdf } from '@/features/consent/services/pdfService';
import { submitConsent } from '@/features/consent/services/consentSubmitService';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';
import { createConsentId } from '@/services/ids';
import { useAuth } from '@/store/authStore';

export default function ConsentProfessionalScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const {
    template,
    consentId,
    values,
    signatures,
    biometrics,
    setSignature,
    setBiometrics,
    setGeneratedPdfUri,
    setSubmission,
    decision,
    getReadingMetrics,
    isStageComplete,
  } = useConsentDraft();

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!template) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>No hay un consentimiento en curso.</Text>
      </View>
    );
  }

  const professionalSignatures = template.signatures.filter(
    (slot) => slot.signer === 'professional'
  );

  async function handleSign() {
    if (!template) return;

    setIsGenerating(true);
    setError(null);
    try {
      // Both signatures are present now, so this is the final document.
      const submission = { values, signatures, signedAt: new Date() };
      const pdf = await generateConsentPdf(template, submission);
      // The URI goes through the draft store, never a route param — see the
      // note on `generatedPdfUri` in consentDraftStore.tsx.
      setGeneratedPdfUri(pdf.uri);

      // From here the consent is signed and the PDF exists. Auditing is
      // bookkeeping on top of that fact and must never be able to undo it —
      // and nobody should watch a spinner for a network timeout after the
      // document is already done. So it runs unawaited; its outcome reaches
      // the closing screen through the draft store, which outlives both.
      void reportSignedConsent(submission, pdf);

      router.replace({ pathname: '/(app)/consent/[code]/done', params: { code } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar el PDF');
      setIsGenerating(false);
    }
  }

  /**
   * Files the consent with the backend: the CONSENT_SIGNED audit record and
   * the PDF together, in one request. The backend checks the PDF against the
   * `pdf_sha256` in the log before storing either, so there is no state where
   * one exists without the other.
   *
   * The document HTML is rebuilt rather than captured from the PDF step:
   * `buildConsentHtml` is pure in (template, submission), so it returns the
   * exact same string the PDF was rendered from — which is what makes
   * `document_hash_sha256` a fingerprint of the signed document and not of
   * some near-copy of it.
   */
  async function reportSignedConsent(
    submission: {
      values: Record<string, string>;
      signatures: Record<string, string>;
      signedAt: Date;
    },
    pdf: { uri: string; sha256: string; base64: string }
  ) {
    if (!template) return;

    const consentIdForLog = consentId ?? createConsentId(submission.signedAt);

    try {
      const patientSlot = template.signatures.find((slot) => slot.signer === 'patient');
      const log = buildConsentSignedLog({
        // A consent id is minted with the template; this fallback only covers
        // a draft restored without one, so the log still has a usable key.
        consentId: consentIdForLog,
        template,
        submission,
        documentHtml: buildConsentHtml(template, submission),
        pdfSha256: pdf.sha256,
        biometrics: patientSlot ? (biometrics[patientSlot.key] ?? null) : null,
        signatureKey: patientSlot?.key,
        operator: user,
        reading: getReadingMetrics(),
        decision,
      });

      const filed = await submitConsent(log, pdf.base64);
      setSubmission(filed);
    } catch (err) {
      // A malformed log is a bug in this code, not a reason to lose the
      // signature — record it and move on.
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[AUDIT] no se pudo registrar la firma:', detail);
      setSubmission({ status: 'rejected', detail });
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Firma del profesional</Text>
      <Text style={styles.body}>
        El paciente ya diligenció y firmó el documento {template.code}. Firme a continuación para
        completar el consentimiento.
      </Text>

      {professionalSignatures.map((slot) => (
        <View key={slot.key} style={styles.signatureSection}>
          <Text style={styles.label}>{slot.label}</Text>
          <SignaturePad
            label={slot.label}
            onChange={(dataUrl) => setSignature(slot.key, dataUrl)}
            onBiometrics={(captured) => setBiometrics(slot.key, captured)}
          />
        </View>
      ))}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {isGenerating ? (
        <ActivityIndicator />
      ) : (
        <Button
          label="Firmar y generar documento"
          onPress={handleSign}
          disabled={!isStageComplete('professional')}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: '700', color: '#12212b' },
  body: { fontSize: 14, lineHeight: 21, color: '#4e6870' },
  label: { fontSize: 13, fontWeight: '600', color: '#4e6870' },
  signatureSection: { gap: 8 },
  error: { fontSize: 14, color: '#dc2626' },
});
