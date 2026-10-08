import type { SignatureBiometrics } from '@/features/consent/services/signatureBiometrics';

/**
 * The audit record written when a consent is signed.
 *
 * Field names are snake_case and the partition/sort keys are spelled out
 * because this object is stored verbatim as a DynamoDB item — the API gateway
 * hands it to the table as-is. Renaming anything here breaks the table's
 * access patterns, so the shape follows the platform blueprint literally
 * rather than the app's usual TypeScript conventions.
 */

/** A signed acceptance, or a signed refusal — both carry the PDF. */
export type ConsentAuditEventType = 'CONSENT_SIGNED' | 'CONSENT_DECLINED';

export type ConsentAuditSubject = {
  patient_id: string;
  id_type: string;
  full_name: string;
  medical_exam_type: string;
};

export type ConsentAuditSignatureData = {
  signature_format: 'PNG_BASE64_HASH';
  /** SHA-256 of the signature PNG's base64 payload, prefix excluded. */
  image_sha256: string;
  stroke_count: number;
  total_duration_ms: number;
  document_version: string;
  /** SHA-256 of the exact HTML the PDF was rendered from. */
  document_hash_sha256: string;
  /**
   * SHA-256 of the signed PDF's bytes — the value `sha256sum` gives for the
   * archived file. This is the fingerprint that binds the log to the document
   * itself: `document_hash_sha256` covers the render input, which nobody can
   * recompute from a PDF, and a re-render never reproduces the same bytes.
   * Empty only on web, where the browser owns the output and the app never
   * sees it.
   */
  pdf_sha256: string;
  /**
   * SHA-256 of the template JSON as the app received it. `document_version` is
   * a string an author has to remember to bump; this detects the case where
   * the wording changed and the version did not.
   */
  template_hash_sha256: string;
};

export type ConsentAuditDeviceContext = {
  device_brand: string;
  device_model: string;
  os_name: string;
  os_version: string;
  app_version: string;
  expo_runtime_version: string;
  screen_resolution: string;
  /**
   * Minutes to add to UTC for the device's local time (Bogotá = -300). The
   * document prints its date in local time while the log records UTC, so
   * without this the printed stamp cannot be re-derived from the log.
   */
  utc_offset_minutes: number;
  /**
   * Always null from the device: an app can only see its LAN address, which is
   * not evidence of anything. The gateway stamps the real source IP from the
   * request context before the item is written.
   */
  ip_address: string | null;
};

export type ConsentAuditCaptureMetadata = {
  operator_id: string;
  clinic_location_id: string;
  time_spent_reading_sec: number;
  has_scrolled_to_bottom: boolean;
  pdf_s3_bucket: string;
  /** Predicted key; the upload step is what makes it real. */
  pdf_s3_key: string;
};

/** Which form was signed. The backend checks it against the published template. */
export type ConsentAuditTemplate = {
  code: string;
  version: string;
  title: string;
  exam_type: string;
};

export type ConsentSignedLog = {
  PK: string;
  SK: string;
  GSI1_PK: string;
  GSI1_SK: string;
  log_id: string;
  consent_id: string;
  timestamp_utc: string;
  event_type: ConsentAuditEventType;
  /** The patient's answer. `declined` goes with event_type CONSENT_DECLINED. */
  decision: 'accepted' | 'declined';
  subject: ConsentAuditSubject;
  template: ConsentAuditTemplate;
  signature_data: ConsentAuditSignatureData;
  biometrics_json: SignatureBiometrics;
  device_context: ConsentAuditDeviceContext;
  capture_metadata: ConsentAuditCaptureMetadata;
};
