/**
 * Datos de ejemplo para desarrollo con los adaptadores simulados. Pasa por
 * `submitConsent`, el mismo camino que la tablet, así que lo sembrado tiene la
 * forma exacta de lo que hay en AWS: evento firmado, PDF verificado, índice.
 *
 * Solo lo llama `src/local.js`, y solo si evidencia y S3 están simulados.
 */
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import config from '../config/env.js';
import logger from '../lib/logger.js';
import { submitConsent } from '../services/consentService.js';
import { publishTemplate } from '../services/templateService.js';

/** Un PDF de una página, válido y legible en cualquier visor. */
export function samplePdf(lines) {
  const esc = (t) => String(t).replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 60 ${760 - i * 22} Td (${esc(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // El API exige un mínimo de bytes; un comentario al final no cambia el documento.
  const pad = Math.max(0, config.s3.minBytes - Buffer.byteLength(out, 'latin1') + 1);
  return Buffer.from(out + `%${' '.repeat(pad)}\n`, 'latin1');
}

const SAMPLES = [
  { patient: '1018293847', name: 'Laura Gómez Pérez', exam: 'TOMA_DE_MUESTRAS', clinic: 'SEDE_NORTE_01', daysAgo: 2 },
  { patient: '1018293847', name: 'Laura Gómez Pérez', exam: 'TOMA_DE_MUESTRAS', clinic: 'SEDE_NORTE_01', daysAgo: 0 },
  { patient: '79845123', name: 'Carlos Ruiz Díaz', exam: 'TOMA_DE_MUESTRAS', clinic: 'SEDE_SUR_02', daysAgo: 5 },
];

/** Publica en el almacén simulado todo lo que hay en templates/, como haría publish-template.mjs. */
async function seedTemplates() {
  const dir = new URL('../../templates/', import.meta.url);
  const published = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    await publishTemplate({ raw, actor: 'seed-local' });
    published.push(`${raw.code} v${raw.version}`);
  }
  logger.info('plantillas de ejemplo publicadas', { published });
}

export async function seedStubConsents() {
  await seedTemplates();
  for (const [i, s] of SAMPLES.entries()) {
    const ts = new Date(Date.now() - s.daysAgo * 86400000 - i * 60000).toISOString();
    const consentId = `CONS-DEMO-${String(i + 1).padStart(3, '0')}`;
    const pdf = samplePdf([
      'Consentimiento informado (EJEMPLO)',
      `Paciente: ${s.name}`,
      `Documento: CC ${s.patient}`,
      `Examen: ${s.exam}`,
      `Sede: ${s.clinic}`,
      `Fecha: ${ts}`,
      `Id: ${consentId}`,
      'Documento de ejemplo generado en modo simulado.',
    ]);
    const pdfSha = crypto.createHash('sha256').update(pdf).digest('hex');
    const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');

    const log = {
      log_id: crypto.randomUUID(),
      consent_id: consentId,
      timestamp_utc: ts,
      event_type: 'CONSENT_SIGNED',
      subject: { patient_id: s.patient, id_type: 'CC', full_name: s.name, medical_exam_type: s.exam },
      // La última muestra simula una tablet con una versión que nunca se publicó.
      template: { code: 'CA-F-14', version: i === 2 ? '0.9' : '1.0', title: 'Protección de datos y consentimiento informado — Toma de muestras', exam_type: s.exam },
      signature_data: {
        signature_format: 'PNG_BASE64_HASH',
        image_sha256: hash(`firma-${i}`),
        stroke_count: 3,
        total_duration_ms: 3200,
        document_version: 'v1.0',
        document_hash_sha256: hash(`doc-${i}`),
        pdf_sha256: pdfSha,
      },
      biometrics_json: { sampling_rate_hz: 60, strokes: [{ stroke_index: 0, points: [{ x: 1, y: 1, p: 0.3, t: 0 }] }] },
      device_context: { device_brand: 'Samsung', device_model: 'SM-X706B', os_name: 'Android', app_version: '1.0.0' },
      capture_metadata: { clinic_location_id: s.clinic, time_spent_reading_sec: 40, has_scrolled_to_bottom: true },
    };

    await submitConsent(
      { log, pdf_base64: pdf.toString('base64') },
      { sourceIp: '127.0.0.1', operatorId: 'seed-tablet', receivedAtIso: ts, requestId: `seed-${i}` },
    );
  }
  logger.info('consentimientos de ejemplo creados', {
    cedulas: [...new Set(SAMPLES.map((s) => s.patient))],
  });
}
