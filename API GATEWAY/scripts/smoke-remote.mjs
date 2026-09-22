#!/usr/bin/env node
/**
 * Prueba de humo contra el API DESPLEGADO, por HTTPS, con Cognito y S3
 * S3 reales. Recorre lo mismo que hará la tablet, en orden:
 *
 *   login → refresh → log de auditoría → reenvío duplicado → URL firmada
 *   → PUT manipulado (S3 debe rechazarlo) → PUT correcto → verificador
 *
 *   node scripts/smoke-remote.mjs --email medico@acr.com --password 'Clinica2026!'
 *   node scripts/smoke-remote.mjs --url https://xxxx.execute-api.us-east-1.amazonaws.com/ ...
 *
 * Sin --url lee el endpoint de `terraform -chdir=infra/api output`. Las
 * comprobaciones finales en S3 usan las credenciales de ~/.aws.
 *
 * Flujo: login → refresh → POST /consents (log + PDF) → reenvío → rechazos →
 * lectura directa de S3 (eventos, cadena, punteros, retenciones).
 *
 * Deja los eventos CONS-SMOKE-<fecha> y un PDF de una página en los buckets,
 * identificables como prueba. No se pueden borrar (Object Lock): expiran solos
 * por ciclo de vida. Por eso el script se niega a correr contra COMPLIANCE.
 */
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GetObjectLockConfigurationCommand,
  GetObjectAttributesCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = 'us-east-1';

// --- argumentos ---------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EMAIL = arg('email') ?? process.env.SMOKE_EMAIL;
const PASSWORD = arg('password') ?? process.env.SMOKE_PASSWORD;
const CLEANUP = argv.includes('--cleanup');

if (!EMAIL || !PASSWORD) {
  console.error('Uso: node scripts/smoke-remote.mjs --email <correo> --password <clave> [--url <endpoint>] [--cleanup]');
  process.exit(2);
}

let BASE = arg('url') ?? process.env.API_URL;
if (!BASE) {
  BASE = execSync('terraform -chdir=infra/api output -raw api_endpoint', { cwd: ROOT, encoding: 'utf8' }).trim();
}
BASE = BASE.replace(/\/+$/, '');

// --- utilidades -----------------------------------------------------------------
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
};
const fatal = (msg) => {
  console.error(`\n✗ ${msg}`);
  summary();
  process.exit(1);
};

async function post(pathname, body, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // no JSON
  }
  return { status: res.status, json, text };
}

/** Un PDF mínimo de una página, distinto en cada ejecución (fecha dentro). */
function samplePdf() {
  const stamp = new Date().toISOString();
  const content = `BT /F1 12 Tf 20 100 Td (Prueba de humo ${stamp}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  // Un comentario de relleno: el API exige un mínimo de 1 KB (un consentimiento
  // real pesa ~150 KB) y este PDF de una línea se queda en 600 bytes.
  let out = `%PDF-1.4\n%${'relleno '.repeat(64)}\n`;
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const now = new Date();
const consentId = `CONS-SMOKE-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const pdf = samplePdf();
const pdfSha256 = createHash('sha256').update(pdf).digest('hex');

function sampleLog() {
  const ts = now.toISOString();
  const patientId = '999999999';
  return {
    PK: `PATIENT#${patientId}`,
    SK: `LOG#${ts}#${consentId}`,
    GSI1_PK: 'CLINIC#SEDE_SMOKE',
    GSI1_SK: `LOG#${ts}`,
    log_id: crypto.randomUUID(),
    consent_id: consentId,
    timestamp_utc: ts,
    event_type: 'CONSENT_SIGNED',
    subject: { patient_id: patientId, id_type: 'CC', full_name: 'Paciente De Prueba', medical_exam_type: 'EXAMEN_INGRESO_OCUPACIONAL' },
    signature_data: {
      signature_format: 'PNG_BASE64_HASH',
      image_sha256: createHash('sha256').update('firma-de-prueba').digest('hex'),
      stroke_count: 2,
      total_duration_ms: 1800,
      document_version: 'v1.0',
      document_hash_sha256: createHash('sha256').update('html-de-prueba').digest('hex'),
      pdf_sha256: pdfSha256,
      template_hash_sha256: createHash('sha256').update('plantilla-de-prueba').digest('hex'),
    },
    biometrics_json: {
      sampling_rate_hz: 60,
      total_duration_ms: 1800,
      device_pressure_supported: false,
      strokes: [
        { stroke_index: 0, points: [{ x: 10, y: 20, p: 0.5, t: 0 }, { x: 14, y: 26, p: 0.5, t: 16 }] },
        { stroke_index: 1, points: [{ x: 60, y: 40, p: 0.5, t: 900 }, { x: 70, y: 55, p: 0.5, t: 916 }] },
      ],
    },
    device_context: {
      device_brand: 'smoke', device_model: 'smoke-remote.mjs', os_name: 'node', os_version: process.version,
      app_version: '0.0.0', expo_runtime_version: 'n/a', screen_resolution: '0x0', utc_offset_minutes: -now.getTimezoneOffset(), ip_address: null,
    },
    capture_metadata: {
      operator_id: 'lo-sobrescribe-el-backend', clinic_location_id: 'SEDE_SMOKE',
      time_spent_reading_sec: 5, has_scrolled_to_bottom: true,
      pdf_s3_bucket: 'prediccion', pdf_s3_key: `consents/prediccion/${consentId}.pdf`,
    },
  };
}

function summary() {
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} comprobaciones correctas · consent_id ${consentId}`);
}

// =============================================================================
// Este script escribe objetos reales bajo Object Lock. En GOVERNANCE expiran
// solos por ciclo de vida; en COMPLIANCE se quedan el plazo completo y el
// bucket no se puede vaciar. Un descuido no puede costar un año de basura en
// el registro legal: si el bucket es COMPLIANCE, no se corre.
{
  const guard = new S3Client({ region: REGION });
  const bucket =
    arg('evidence-bucket') ??
    process.env.EVIDENCE_BUCKET ??
    execSync('terraform -chdir=infra/platform output -raw evidence_bucket', { cwd: ROOT, encoding: 'utf8' }).trim();
  const lock = await guard.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
  const mode = lock.ObjectLockConfiguration?.Rule?.DefaultRetention?.Mode;
  if (mode === 'COMPLIANCE') {
    console.error(`✗ ${bucket} está en modo COMPLIANCE: este smoke no corre contra producción. Usa el entorno dev.`);
    process.exit(2);
  }
  console.log(`bucket de evidencia: ${bucket} (${mode ?? 'sin retención'})`);
}

console.log(`API: ${BASE}\n`);

// --- 1. login -----------------------------------------------------------------------
const login = await post('/auth/login', { email: EMAIL, password: PASSWORD });
if (!check('login', login.status === 200 && login.json?.token, `HTTP ${login.status} ${login.json?.message ?? ''}`)) fatal('sin sesión no se puede seguir');
let token = login.json.token;
check('login devuelve refreshToken', Boolean(login.json.refreshToken));
check('login devuelve user {id,email,name}', Boolean(login.json.user?.id && login.json.user?.email && login.json.user?.name), JSON.stringify(login.json.user));

// --- 2. refresh ---------------------------------------------------------------------------
const refresh = await post('/auth/refresh', { refresh_token: login.json.refreshToken });
if (check('refresh', refresh.status === 200 && refresh.json?.token, `HTTP ${refresh.status} ${refresh.json?.message ?? ''}`)) {
  token = refresh.json.token;
}

// --- 3. sin token → 401 -----------------------------------------------------------------
const noAuth = await post('/consents', {});
check('ruta protegida sin token → 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

// --- 4. el consentimiento: log + PDF en una llamada ------------------------------------------
const log = sampleLog();
const body = { log, pdf_base64: pdf.toString('base64') };
const first = await post('/consents', body, token);
if (!check('POST /consents → 201', first.status === 201, `HTTP ${first.status} ${first.text.slice(0, 200)}`)) fatal('sin consentimiento registrado no hay nada que comprobar');
const key = first.json.pdf?.key;
check('la respuesta trae la clave real del PDF y los hashes de los dos eventos',
  key === `consents/${now.toISOString().slice(0, 4)}/${now.toISOString().slice(5, 7)}/${consentId}.pdf` &&
  /^[0-9a-f]{64}$/.test(first.json.events?.signed_sha256 ?? '') && /^[0-9a-f]{64}$/.test(first.json.events?.verified_sha256 ?? ''),
  JSON.stringify(first.json).slice(0, 200));
check('pdf.sha256 de la respuesta == sha256 de lo enviado', first.json.pdf?.sha256 === pdfSha256);

// --- 5. reenvío del outbox: idempotente ----------------------------------------------------
const dup = await post('/consents', body, token);
check('reenvío del mismo consentimiento → 200 duplicate', dup.status === 200 && dup.json?.duplicate === true, `HTTP ${dup.status} ${dup.text.slice(0, 120)}`);
check('el reenvío devuelve los mismos hashes', dup.json?.events?.signed_sha256 === first.json.events?.signed_sha256 && dup.json?.events?.verified_sha256 === first.json.events?.verified_sha256);

// --- 6. un byte corrupto: el API lo rechaza antes de escribir nada ------------------------------
const tampered = Buffer.from(pdf);
tampered[tampered.length - 10] ^= 0x01;
const otherId = `${consentId}-MAL`;
const bad = await post('/consents', { log: { ...log, consent_id: otherId, log_id: randomUUID() }, pdf_base64: tampered.toString('base64') }, token);
check('PDF con un byte corrupto → 400 pdf_hash_mismatch', bad.status === 400 && bad.json?.code === 'pdf_hash_mismatch', `HTTP ${bad.status} ${bad.text.slice(0, 120)}`);

// --- 7. otro documento bajo el mismo id → 409 ------------------------------------------------------
const other = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 0x42)]);
const clash = await post('/consents', {
  log: { ...log, log_id: randomUUID(), signature_data: { ...log.signature_data, pdf_sha256: createHash('sha256').update(other).digest('hex') } },
  pdf_base64: other.toString('base64'),
}, token);
check('otro PDF bajo el mismo consent_id → 409', clash.status === 409, `HTTP ${clash.status} ${clash.text.slice(0, 120)}`);

// --- 8. el registro de evidencia en S3 --------------------------------------------------
const s3 = new S3Client({ region: REGION });

const evidenceBucket =
  arg('evidence-bucket') ??
  process.env.EVIDENCE_BUCKET ??
  execSync('terraform -chdir=infra/platform output -raw evidence_bucket', { cwd: ROOT, encoding: 'utf8' }).trim();

const eventKey = (seq, type) => `events/${consentId}/${String(seq).padStart(4, '0')}-${type}.json`;

async function getObjectBytes(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    if (err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

// 0001: lo que escribió el API al recibir el log.
const bytes1 = await getObjectBytes(evidenceBucket, eventKey(1, 'CONSENT_SIGNED'));
const ev1 = bytes1 ? JSON.parse(bytes1.toString('utf8')) : null;
check('evento 0001-CONSENT_SIGNED en S3', Boolean(ev1), ev1 ? `${bytes1.length} bytes` : 'no existe');
check('sobre: schema, seq 1, prev_hash null',
  ev1?.schema === 'acr.consent.event/1' && ev1?.seq === 1 && ev1?.prev_hash === null);
check('operator_id sobrescrito con el sub del token',
  ev1?.payload?.capture_metadata?.operator_id && ev1.payload.capture_metadata.operator_id !== 'lo-sobrescribe-el-backend',
  ev1?.payload?.capture_metadata?.operator_id);
check('ip_address estampada por el gateway',
  typeof ev1?.payload?.device_context?.ip_address === 'string' && ev1.payload.device_context.ip_address.length > 0,
  ev1?.payload?.device_context?.ip_address ?? 'null');
check('pdf_s3_key del evento es la clave real, no la predicción del dispositivo', ev1?.payload?.capture_metadata?.pdf_s3_key === key, ev1?.payload?.capture_metadata?.pdf_s3_key);
check('los rechazos no dejaron eventos', !(await getObjectBytes(evidenceBucket, `events/${otherId}/0001-CONSENT_SIGNED.json`)));

// 0002: lo escribió el API en la misma petición, tras guardar el PDF.
const bytes2 = await getObjectBytes(evidenceBucket, eventKey(2, 'PDF_VERIFIED'));
const ev2 = bytes2 ? JSON.parse(bytes2.toString('utf8')) : null;
check('evento 0002-PDF_VERIFIED escrito en la misma petición', Boolean(ev2), ev2 ? `${bytes2.length} bytes` : 'no existe');
check('verified = true', ev2?.payload?.verified === true, JSON.stringify(ev2?.payload));

// La cadena: el prev_hash de 0002 es el SHA-256 de los BYTES de 0001 tal como están en S3.
const sha1 = bytes1 ? createHash('sha256').update(bytes1).digest('hex') : null;
check('cadena intacta: sha256(bytes de 0001) == prev_hash de 0002', sha1 && ev2?.prev_hash === sha1, `${sha1?.slice(0, 16)}… vs ${ev2?.prev_hash?.slice(0, 16)}…`);
check('los hashes que devolvió el API son los de los objetos en S3',
  first.json.events?.signed_sha256 === sha1 && bytes2 && first.json.events?.verified_sha256 === createHash('sha256').update(bytes2).digest('hex'));

// Punteros del índice: listar por prefijo ES la consulta.
const list = await s3.send(new ListObjectsV2Command({ Bucket: evidenceBucket, Prefix: `index/patient/999999999/` }));
const pointer = (list.Contents ?? []).find((o) => o.Key.endsWith(`_${consentId}`));
check('puntero index/patient/<cédula>/<fecha>_<id>', Boolean(pointer), pointer?.Key ?? 'no encontrado');
check('el puntero está vacío (0 bytes)', pointer?.Size === 0, pointer?.Size);

// Object Lock: cada evento queda bloqueado al escribirse.
try {
  const ret = await s3.send(new GetObjectRetentionCommand({ Bucket: evidenceBucket, Key: eventKey(1, 'CONSENT_SIGNED') }));
  const until = new Date(ret.Retention.RetainUntilDate);
  const days = Math.round((until - now) / 86400000);
  check('0001 bajo Object Lock ~365 días', ret.Retention.Mode && days >= 364 && days <= 366, `${ret.Retention.Mode} hasta ${until.toISOString().slice(0, 10)} (${days} d)`);
} catch (err) {
  check('0001 bajo Object Lock', false, err.name);
}

// El objeto del PDF: checksum registrado por S3 y bloqueo de ~30 días.
try {
  const pdfBucket = first.json.pdf.bucket;
  const attrs = await s3.send(new GetObjectAttributesCommand({ Bucket: pdfBucket, Key: key, ObjectAttributes: ['Checksum', 'ObjectSize'] }));
  check('PDF en S3 con checksum SHA-256 == el del log', attrs.Checksum?.ChecksumSHA256 === Buffer.from(pdfSha256, 'hex').toString('base64'), `${attrs.ObjectSize} bytes`);
  const ret = await s3.send(new GetObjectRetentionCommand({ Bucket: pdfBucket, Key: key }));
  const days = Math.round((new Date(ret.Retention.RetainUntilDate) - now) / 86400000);
  check('PDF bajo Object Lock ~30 días', days >= 29 && days <= 31, `${ret.Retention.Mode} ${days} d`);
} catch (err) {
  check('PDF en S3', false, err.name);
}

// --- limpieza opcional ------------------------------------------------------------------------------
// Con Object Lock no hay limpieza posible: los objetos de prueba expiran solos
// por ciclo de vida (PDF a los 31 días, eventos a los 366). Por eso el script se
// niega a correr contra un bucket COMPLIANCE (ver arriba): en producción una
// prueba dejaría basura un año.
if (CLEANUP) {
  console.log('\n(--cleanup no aplica: Object Lock impide borrar; los objetos de prueba expiran por ciclo de vida)');
}

summary();
process.exit(results.every((r) => r.ok) ? 0 : 1);
