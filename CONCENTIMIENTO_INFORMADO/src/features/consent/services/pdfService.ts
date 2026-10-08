import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { buildConsentHtml } from '@/features/consent/services/documentHtml';
import type { ConsentSubmission, ConsentTemplate } from '@/features/consent/types/consent';
import { base64ToBytes } from '@/services/base64';
import { sha256HexBytes } from '@/services/sha256';

/** Where finished PDFs land in Phase 1. Stands in for the S3 `generated/` prefix. */
const OUTPUT_DIR_NAME = 'consents';

/** A draft carries a marker in its name so it is never mistaken for the final file. */
export type PdfVariant = 'final' | 'preliminar';

/**
 * A rendered PDF and the fingerprint of its bytes.
 *
 * The hash is taken from the same bytes that are written to disk, so anyone
 * holding the archived file can run `sha256sum` on it and get this value back.
 * That is what makes the audit log's `pdf_sha256` verifiable against the
 * document itself instead of against a re-render, which would never match:
 * the platform's print engine stamps its own creation date and producer into
 * every PDF, so the same HTML rendered twice does not give the same bytes.
 */
export type GeneratedPdf = {
  /** Local file URI. Empty on web, where the browser owns the output. */
  uri: string;
  /** Lowercase hex SHA-256 of the file's bytes. Empty when there is no file. */
  sha256: string;
  /**
   * The same bytes, base64-encoded — what `POST /consents` carries. Kept from
   * the print step instead of re-read from disk so the hash and the upload are
   * guaranteed to describe the same content. Empty when there is no file.
   */
  base64: string;
};

function outputFileName(template: ConsentTemplate, signedAt: Date, variant: PdfVariant): string {
  const stamp = signedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const code = template.code.replace(/[^a-zA-Z0-9._-]/g, '-');
  const version = template.version.replace(/[^a-zA-Z0-9._-]/g, '-');
  const suffix = variant === 'preliminar' ? '-PRELIMINAR' : '';
  return `${code}-v${version}-${stamp}${suffix}.pdf`;
}

/**
 * Phase 1 PDF pipeline: template blocks + submitted values + captured
 * signatures → HTML → PDF on disk.
 *
 * expo-print writes to the raw app cache (`cache/Print/<uuid>.pdf`). Under
 * Expo Go that path is outside the scoped sandbox, and both expo-sharing and
 * expo-file-system consult the same FilePermissionService — so neither can
 * read it ("Not allowed to read file under given URL" / "Missing 'READ'
 * permission"). Rather than relocate a file we are not allowed to open, we ask
 * expo-print for the bytes directly (`base64: true`, returned over the bridge,
 * no filesystem read involved) and write them into a file we own inside
 * `Paths.cache`. This write is the seam that becomes
 * `StorageService.putObject()` in Phase 2.
 */
export async function generateConsentPdf(
  template: ConsentTemplate,
  submission: ConsentSubmission,
  variant: PdfVariant = 'final'
): Promise<GeneratedPdf> {
  const html = buildConsentHtml(template, submission);

  if (Platform.OS === 'web') {
    // No filesystem to write into — hand the document to the browser's own
    // print dialog, where the user can "Save as PDF". The bytes never pass
    // through the app, so there is nothing here to fingerprint.
    await Print.printAsync({ html });
    return { uri: '', sha256: '', base64: '' };
  }

  const { base64 } = await Print.printToFileAsync({ html, base64: true });
  if (!base64) {
    throw new Error('No se pudo generar el contenido del PDF');
  }

  const outputDir = new Directory(Paths.cache, OUTPUT_DIR_NAME);
  if (!outputDir.exists) {
    outputDir.create({ intermediates: true });
  }

  const destination = new File(outputDir, outputFileName(template, submission.signedAt, variant));
  if (destination.exists) {
    destination.delete();
  }
  destination.create();
  destination.write(base64, { encoding: 'base64' });

  // Hashed from the decoded bytes — the exact content `write` just put on
  // disk. Hashing the base64 text instead would produce a digest nobody could
  // reproduce from the file.
  return { uri: destination.uri, sha256: sha256HexBytes(base64ToBytes(base64)), base64 };
}

/**
 * Discards a generated file. Used for the preliminary draft, which must not
 * outlive the preview screen — a patient-only PDF should never be sitting in
 * the cache where it could later be mistaken for the signed record.
 */
export function deleteConsentPdf(uri: string | null): void {
  if (!uri || Platform.OS === 'web') return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone, or never written — nothing to clean up.
  }
}

export async function shareConsentPdf(uri: string): Promise<void> {
  if (!uri) return; // web path already handed off to the print dialog

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Compartir archivos no está disponible en este dispositivo');
  }

  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: 'Consentimiento informado',
  });
}
