import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { SignaturePad } from '@/components/ui/SignaturePad';
import { ConsentFields } from '@/features/consent/components/ConsentFields';
import { fieldsFilledBy, isFieldRequired } from '@/features/consent/services/fieldRules';
import { buildConsentSignedLog } from '@/features/audit/services/auditLogBuilder';
import { buildConsentHtml } from '@/features/consent/services/documentHtml';
import { generateConsentPdf } from '@/features/consent/services/pdfService';
import { submitConsent } from '@/features/consent/services/consentSubmitService';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';
import type { ConsentTemplate, DecisionChoice } from '@/features/consent/types/consent';
import { createConsentId } from '@/services/ids';
import { useAuth } from '@/store/authStore';

type SignedSubmission = {
  values: Record<string, string>;
  signatures: Record<string, string>;
  signedAt: Date;
  decision: DecisionChoice | null;
};

type GeneratedPdf = { uri: string; sha256: string; base64: string };

export default function ConsentProfessionalScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const {
    templates,
    consentIds,
    signatureSlots,
    fields,
    values,
    signatures,
    biometrics,
    setValue,
    setSignature,
    setBiometrics,
    setGeneratedPdfUris,
    setSubmission,
    decision,
    getReadingMetrics,
    isStageComplete,
  } = useConsentDraft();

  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (templates.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>No hay un consentimiento en curso.</Text>
      </View>
    );
  }

  const codes = templates.map((form) => form.code);
  const professionalSignatures = signatureSlots.filter((slot) => slot.signer === 'professional');
  // What only the professional fills in: the decision-ability assessment,
  // registration number, role…
  const professionalFields = fieldsFilledBy(fields, 'professional', decision);

  async function handleSign() {
    setIsGenerating(true);
    setError(null);
    try {
      // Both signatures are present now, so these are the final documents.
      // One timestamp for all of them: they were signed in the same act.
      const submission: SignedSubmission = { values, signatures, signedAt: new Date(), decision };

      // One PDF per form, with the same data and signatures. Built one after
      // another: each render holds a full document in memory.
      const pdfs: GeneratedPdf[] = [];
      for (const [i, form] of templates.entries()) {
        setProgress(templates.length > 1 ? `Generando documento ${i + 1} de ${templates.length}…` : null);
        pdfs.push(await generateConsentPdf(form, submission));
      }
      // The URIs go through the draft store, never a route param — see the
      // note on `generatedPdfUris` in consentDraftStore.tsx.
      setGeneratedPdfUris(pdfs.map((pdf) => pdf.uri));

      // From here the consents are signed and the PDFs exist. Auditing is
      // bookkeeping on top of that fact and must never be able to undo it —
      // and nobody should watch a spinner for a network timeout after the
      // documents are already done. So it runs unawaited; its outcome reaches
      // the closing screen through the draft store, which outlives both.
      void reportSignedConsents(submission, pdfs);

      router.replace({ pathname: '/(app)/consent/[code]/done', params: { code } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar el PDF');
      setIsGenerating(false);
      setProgress(null);
    }
  }

  /** Files each consent in turn; one failing does not stop the others. */
  async function reportSignedConsents(submission: SignedSubmission, pdfs: GeneratedPdf[]) {
    for (const [i, form] of templates.entries()) {
      await reportSignedConsent(i, form, submission, pdfs[i]);
    }
  }

  /**
   * Files one consent with the backend: the CONSENT_SIGNED audit record and
   * its PDF together, in one request. The backend checks the PDF against the
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
    index: number,
    form: ConsentTemplate,
    submission: SignedSubmission,
    pdf: GeneratedPdf
  ) {
    // An id is minted per form when the session loads; this fallback only
    // covers a draft restored without one, so the log still has a usable key.
    const consentIdForLog = consentIds[index] ?? createConsentId(submission.signedAt);

    try {
      // Biometrics of whoever signed on the patient's side: the patient, or —
      // under substitute consent, when the patient does not sign — the
      // representative.
      const patientSide = form.signatures.filter((slot) => slot.signer === 'patient');
      const patientSlot = patientSide.find((slot) => signatures[slot.key]) ?? patientSide[0];
      const log = buildConsentSignedLog({
        consentId: consentIdForLog,
        template: form,
        submission,
        documentHtml: buildConsentHtml(form, submission),
        pdfSha256: pdf.sha256,
        biometrics: patientSlot ? (biometrics[patientSlot.key] ?? null) : null,
        signatureKey: patientSlot?.key,
        operator: user,
        reading: getReadingMetrics(),
        decision: form.decision ? decision : null,
      });

      const filed = await submitConsent(log, pdf.base64);
      setSubmission(index, filed);
    } catch (err) {
      // A malformed log is a bug in this code, not a reason to lose the
      // signature — record it and move on.
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[AUDIT] no se pudo registrar la firma de ${form.code}:`, detail);
      setSubmission(index, { status: 'rejected', detail });
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Firma del profesional</Text>
      <Text style={styles.body}>
        {codes.length === 1
          ? `El paciente ya diligenció y firmó el documento ${codes[0]}. Firme a continuación para completar el consentimiento.`
          : `El paciente ya diligenció y firmó ${codes.length} documentos (${codes.join(', ')}). Su firma se aplica a todos; se generará un PDF por cada uno.`}
      </Text>

      {professionalFields.length > 0 ? (
        <ConsentFields
          fields={professionalFields}
          values={values}
          onChange={setValue}
          disabled={isGenerating}
          isRequired={(field) => isFieldRequired(field, values, decision)}
        />
      ) : null}

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
        <View style={styles.generating}>
          <ActivityIndicator />
          {progress ? <Text style={styles.body}>{progress}</Text> : null}
        </View>
      ) : (
        <Button
          label={codes.length === 1 ? 'Firmar y generar documento' : `Firmar y generar ${codes.length} documentos`}
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
  generating: { alignItems: 'center', gap: 8 },
  error: { fontSize: 14, color: '#dc2626' },
});
