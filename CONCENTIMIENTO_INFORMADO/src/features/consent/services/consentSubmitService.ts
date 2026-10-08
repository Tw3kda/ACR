import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { ConsentSignedLog } from '@/features/audit/types/auditLog';
import { apiConfig } from '@/services/api/config';
import { postJson } from '@/services/apiClient';

/**
 * Files a signed consent with the backend: the audit log and the PDF together,
 * in one `POST /consents`. The backend checks the PDF against the hash in the
 * log, stores both under Object Lock and answers with the hashes of the two
 * evidence events it wrote. There is no separate upload step and nothing to
 * verify afterwards — the response *is* the verification.
 *
 * Two rules shape this module:
 *
 * 1. **Signing never fails because filing failed.** The patient has already
 *    signed and the PDF already exists; a network problem cannot be allowed to
 *    unwind that. Nothing here throws — callers get a status instead.
 * 2. **Nothing is lost.** A consent that could not be filed goes to an outbox
 *    ON DISK (log + PDF, one file per consent) and is retried when the app
 *    starts, comes to the foreground, or files the next consent. The previous
 *    in-memory outbox died with the process; a signed consent that only
 *    existed there was gone after a reboot.
 *
 * Definitive rejections (4xx other than 401/408/429) are not retried: the
 * backend has said this payload will never be accepted — a hash mismatch is a
 * bug here, a conflict is a data problem. Those move to `outbox/rejected/` so
 * they are still on the device for a human to look at, but stop looping.
 */

export type ConsentSubmissionStatus =
  /** Accepted and verified by the backend. */
  | 'sent'
  /** Could not reach the backend; saved on disk and will be retried. */
  | 'queued'
  /** Backend rejected it definitively; saved under rejected/ for inspection. */
  | 'rejected'
  /** Nothing to file: web hands the PDF to the browser, the app never sees it. */
  | 'skipped';

export type ConsentSubmission = {
  status: ConsentSubmissionStatus;
  detail?: string;
  /** Backend's record of what it stored, on `sent`. */
  receipt?: ConsentReceipt;
};

/** What `POST /consents` answers. */
export type ConsentReceipt = {
  consent_id: string;
  log_id: string | null;
  duplicate?: boolean;
  pdf: { bucket: string; key: string; sha256: string; size_bytes: number };
  events: { signed_sha256: string; verified_sha256: string };
};

type OutboxEntry = {
  queued_at: string;
  attempts: number;
  log: ConsentSignedLog;
  pdf_base64: string;
};

const OUTBOX_DIR = 'outbox';
const REJECTED_DIR = 'rejected';

function outboxDir(): Directory | null {
  if (Platform.OS === 'web') return null;
  const dir = new Directory(Paths.document, OUTBOX_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function rejectedDir(): Directory | null {
  const parent = outboxDir();
  if (!parent) return null;
  const dir = new Directory(parent, REJECTED_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function entryFile(consentId: string): File | null {
  const dir = outboxDir();
  return dir ? new File(dir, `${consentId}.json`) : null;
}

/** A 4xx the backend will keep answering the same way; retrying is pointless. */
function isDefinitiveRejection(httpStatus: number | null): boolean {
  if (httpStatus === null) return false;
  if (httpStatus === 401 || httpStatus === 408 || httpStatus === 429) return false;
  return httpStatus >= 400 && httpStatus < 500;
}

async function post(log: ConsentSignedLog, pdfBase64: string) {
  return postJson<ConsentReceipt>(
    apiConfig.paths.consents,
    { log, pdf_base64: pdfBase64 },
    { label: `CONSENT · ${log.consent_id}` }
  );
}

function enqueue(log: ConsentSignedLog, pdfBase64: string, attempts: number): boolean {
  const file = entryFile(log.consent_id);
  if (!file) return false;
  const entry: OutboxEntry = {
    queued_at: new Date().toISOString(),
    attempts,
    log,
    pdf_base64: pdfBase64,
  };
  try {
    if (!file.exists) file.create();
    file.write(JSON.stringify(entry));
    return true;
  } catch (error) {
    console.warn('[CONSENT] no se pudo guardar en el outbox:', error);
    return false;
  }
}

function reject(consentId: string, entry: OutboxEntry | null, reason: string): void {
  const dir = rejectedDir();
  const pending = entryFile(consentId);
  if (!dir) return;
  try {
    const target = new File(dir, `${consentId}.json`);
    if (target.exists) target.delete();
    target.create();
    target.write(JSON.stringify({ ...entry, rejected_at: new Date().toISOString(), reason }));
    if (pending?.exists) pending.delete();
  } catch (error) {
    console.warn('[CONSENT] no se pudo mover al rechazado:', error);
  }
}

/**
 * Files a consent now. On failure it is queued on disk; the returned status
 * says which happened.
 */
export async function submitConsent(
  log: ConsentSignedLog,
  pdfBase64: string
): Promise<ConsentSubmission> {
  if (!pdfBase64) {
    return { status: 'skipped', detail: 'no hay archivo local que enviar' };
  }

  const result = await post(log, pdfBase64);

  if (result.status === 'sent') {
    // A retry from the outbox that finally got through: nothing left to keep.
    const pending = entryFile(log.consent_id);
    if (pending?.exists) pending.delete();
    return { status: 'sent', receipt: result.data };
  }

  const detail = `${result.httpStatus ?? 'sin respuesta'} · ${result.message}`;

  if (isDefinitiveRejection(result.httpStatus)) {
    reject(log.consent_id, { queued_at: new Date().toISOString(), attempts: 1, log, pdf_base64: pdfBase64 }, detail);
    return { status: 'rejected', detail };
  }

  const queued = enqueue(log, pdfBase64, 1);
  return {
    status: 'queued',
    detail: queued ? detail : `${detail} · y no se pudo guardar en el outbox`,
  };
}

/** Consents waiting on disk, oldest first. */
export function pendingConsents(): string[] {
  const dir = outboxDir();
  if (!dir) return [];
  try {
    return dir
      .list()
      .filter((item): item is File => item instanceof File && item.name.endsWith('.json'))
      .map((file) => file.name.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

let flushing: Promise<{ sent: number; remaining: number }> | null = null;

/**
 * Retries everything in the outbox, one at a time, oldest first. Safe to call
 * from several places at once: concurrent calls share one run. Entries that
 * still cannot be delivered stay queued; definitive rejections are moved
 * aside.
 */
export function flushPendingConsents(): Promise<{ sent: number; remaining: number }> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    const dir = outboxDir();
    if (!dir) return { sent: 0, remaining: 0 };

    for (const consentId of pendingConsents()) {
      const file = new File(dir, `${consentId}.json`);
      let entry: OutboxEntry;
      try {
        entry = JSON.parse(file.textSync()) as OutboxEntry;
      } catch (error) {
        // Unreadable entry: keep it (it is still the only copy) and move on.
        console.warn('[CONSENT] entrada del outbox ilegible:', consentId, error);
        continue;
      }

      const result = await post(entry.log, entry.pdf_base64);
      if (result.status === 'sent') {
        file.delete();
        sent += 1;
        continue;
      }
      const detail = `${result.httpStatus ?? 'sin respuesta'} · ${result.message}`;
      if (isDefinitiveRejection(result.httpStatus)) {
        reject(consentId, entry, detail);
        continue;
      }
      // Still transient: bump the counter and stop — if this one cannot get
      // through, the rest will not either, and each carries a PDF.
      enqueue(entry.log, entry.pdf_base64, entry.attempts + 1);
      break;
    }

    return { sent, remaining: pendingConsents().length };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
