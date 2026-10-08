import { collectDeviceContext } from '@/features/audit/services/deviceContext';
import type { ConsentSignedLog } from '@/features/audit/types/auditLog';
import {
  emptyBiometrics,
  type SignatureBiometrics,
} from '@/features/consent/services/signatureBiometrics';
import type { ConsentSubmission, ConsentTemplate } from '@/features/consent/types/consent';
import { apiConfig } from '@/services/api/config';
import { uuidv4 } from '@/services/ids';
import { sha256Hex } from '@/services/sha256';
import { PATIENT_ID_KEYS, PATIENT_NAME_KEYS } from '@/features/consent/services/fieldFilters';

/**
 * Turns a finished signing session into the DynamoDB item the audit service
 * stores. Pure: it takes what the flow already collected and returns the log —
 * no I/O, so it can be logged, inspected or replayed without side effects.
 */

/**
 * Field keys that hold the patient's identity. Templates are authored by the
 * clinic, so the log looks for any of the usual spellings rather than hard
 * coding one form's key.
 */

function firstValue(values: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = values[key];
    if (value && value.trim().length > 0) return value.trim();
  }
  return '';
}

/** Strips the `data:image/png;base64,` prefix so the hash covers the bytes only. */
function base64Payload(dataUrl: string): string {
  const separator = dataUrl.indexOf(',');
  return separator >= 0 ? dataUrl.slice(separator + 1) : dataUrl;
}

function documentVersion(template: ConsentTemplate): string {
  return template.version.startsWith('v') ? template.version : `v${template.version}`;
}

/** `consents/2026/08/CONS-2026-0831-042.pdf` — the key the upload will use. */
function pdfObjectKey(consentId: string, signedAt: Date): string {
  const year = signedAt.getUTCFullYear();
  const month = String(signedAt.getUTCMonth() + 1).padStart(2, '0');
  return `${apiConfig.storage.pdfPrefix}/${year}/${month}/${consentId}.pdf`;
}

export type ConsentSignedLogInput = {
  consentId: string;
  template: ConsentTemplate;
  submission: ConsentSubmission;
  /** The exact HTML the PDF was rendered from — hashed, not sent. */
  documentHtml: string;
  /**
   * SHA-256 of the generated PDF's bytes, from `generateConsentPdf`. Empty
   * only where no file was produced (web), and the log says so plainly rather
   * than carrying a hash of something else.
   */
  pdfSha256: string;
  /** Stroke capture for the patient's signature, when the pad produced one. */
  biometrics: SignatureBiometrics | null;
  /** The logged-in professional; null if the session somehow has no user. */
  operator: { id: string } | null;
  reading: { timeSpentReadingSec: number; hasScrolledToBottom: boolean };
  /** Signature slot whose image is fingerprinted. Defaults to the patient's. */
  signatureKey?: string;
  /**
   * The patient's answer on a form with an accept/decline step. `decline`
   * files a CONSENT_DECLINED — still a signed document, with its PDF.
   */
  decision?: 'accept' | 'decline' | null;
};

export function buildConsentSignedLog(input: ConsentSignedLogInput): ConsentSignedLog {
  const { consentId, template, submission, documentHtml, pdfSha256, operator, reading } = input;

  const signedAt = submission.signedAt;
  const timestampUtc = signedAt.toISOString();
  const biometrics = input.biometrics ?? emptyBiometrics();

  const signatureKey =
    input.signatureKey ??
    template.signatures.find((slot) => slot.signer === 'patient')?.key ??
    'patient';
  const signatureDataUrl = submission.signatures[signatureKey] ?? '';

  const patientId = firstValue(submission.values, PATIENT_ID_KEYS);
  const fullName = firstValue(submission.values, PATIENT_NAME_KEYS);

  return {
    // Access pattern: everything about one patient, newest first.
    PK: `PATIENT#${patientId || 'DESCONOCIDO'}`,
    SK: `LOG#${timestampUtc}#${consentId}`,
    // Access pattern: everything signed at one clinic, newest first.
    GSI1_PK: `CLINIC#${apiConfig.clinic.locationId}`,
    GSI1_SK: `LOG#${timestampUtc}`,

    log_id: uuidv4(),
    consent_id: consentId,
    timestamp_utc: timestampUtc,
    event_type: input.decision === 'decline' ? 'CONSENT_DECLINED' : 'CONSENT_SIGNED',
    decision: input.decision === 'decline' ? 'declined' : 'accepted',

    subject: {
      patient_id: patientId,
      id_type: apiConfig.clinic.defaultIdType,
      full_name: fullName,
      // The form decides what procedure this is; older templates without an
      // examType fall back to what the deployment declares.
      medical_exam_type: template.examType ?? apiConfig.clinic.defaultExamType,
    },

    template: {
      code: template.code,
      version: template.version,
      title: template.title,
      exam_type: template.examType ?? apiConfig.clinic.defaultExamType,
    },

    signature_data: {
      signature_format: 'PNG_BASE64_HASH',
      image_sha256: signatureDataUrl ? sha256Hex(base64Payload(signatureDataUrl)) : '',
      stroke_count: biometrics.strokes.length,
      total_duration_ms: biometrics.total_duration_ms,
      document_version: documentVersion(template),
      document_hash_sha256: sha256Hex(documentHtml),
      pdf_sha256: pdfSha256,
      // The template as this device holds it. Key order comes from the stored
      // JSON, so it is stable for a given stored document — enough to catch
      // wording that changed without a version bump, not a canonical form.
      template_hash_sha256: sha256Hex(JSON.stringify(template)),
    },

    biometrics_json: biometrics,
    device_context: collectDeviceContext(signedAt),

    capture_metadata: {
      operator_id: operator?.id ?? 'DESCONOCIDO',
      clinic_location_id: apiConfig.clinic.locationId,
      time_spent_reading_sec: Math.max(0, Math.round(reading.timeSpentReadingSec)),
      has_scrolled_to_bottom: reading.hasScrolledToBottom,
      pdf_s3_bucket: apiConfig.storage.pdfBucket,
      pdf_s3_key: pdfObjectKey(consentId, signedAt),
    },
  };
}
