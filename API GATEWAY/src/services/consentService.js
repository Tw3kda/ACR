import { createHash } from 'node:crypto';

import config from '../config/env.js';
import { evidence, s3 } from '../aws/index.js';
import { badRequest, conflict, payloadTooLarge } from '../lib/errors.js';
import { isHex64, isSafeId, requireObject } from '../lib/validate.js';
import logger from '../lib/logger.js';
import { EVENT_SCHEMA, buildSignedEvent, writePointers } from './auditService.js';

/**
 * `POST /consents`: el consentimiento firmado entra entero, en una llamada —
 * el log y el PDF juntos — y sale registrado y verificado, o no sale.
 *
 * Antes eran tres llamadas (log, URL firmada, PUT a S3) y un Lambda asíncrono
 * que verificaba después. Cada hueco entre ellas era un estado a medias: log
 * sin PDF, PDF sin verificar. Aquí no hay huecos: el hash se comprueba dos
 * veces (aquí, y S3 al guardar) antes de que exista ningún evento, y el
 * evento de verificación se escribe en la misma petición.
 *
 * Orden de escritura, pensado para que un reintento termine lo que un fallo
 * dejó a medias:
 *   1. PDF (If-None-Match; si ya existe con el mismo checksum, se sigue)
 *   2. 0001-CONSENT_SIGNED (idem; mismo log_id = reenvío, otro = 409)
 *   3. 0002-PDF_VERIFIED, encadenado a los bytes de 0001 tal como quedaron
 *   4. punteros del índice
 */

const PDF_MAGIC = '%PDF-';

/** hex -> base64: lo que S3 espera en `ChecksumSHA256`. */
export const hexToBase64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
export const base64ToHex = (b64) => Buffer.from(b64, 'base64').toString('hex');

/**
 * La clave la construye el servidor, nunca el cliente.
 *
 * `capture_metadata.pdf_s3_key` llega en el log como una *predicción* hecha
 * antes de que existiera la clave real. La real se deriva del id y la fecha, y
 * se escribe en el evento en lugar de la predicción.
 */
export function buildPdfKey(consentId, timestampIso) {
  if (!isSafeId(consentId)) {
    throw badRequest('Identificador de consentimiento inválido', { details: { consentId } });
  }
  const date = new Date(timestampIso);
  const ref = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = ref.getUTCFullYear();
  const month = String(ref.getUTCMonth() + 1).padStart(2, '0');
  return `${config.s3.keyPrefix}/${year}/${month}/${consentId}.pdf`;
}

function decodePdf(pdfBase64) {
  if (typeof pdfBase64 !== 'string' || pdfBase64.length === 0) {
    throw badRequest('El campo "pdf_base64" es obligatorio', { details: { field: 'pdf_base64' } });
  }
  // El límite se mira sobre el texto antes de decodificar: decodificar para
  // descubrir que era demasiado grande es trabajo regalado.
  if (pdfBase64.length > Math.ceil(config.s3.maxBytes / 3) * 4 + 4) {
    throw payloadTooLarge('El documento excede el tamaño máximo permitido', {
      details: { max_bytes: config.s3.maxBytes },
    });
  }
  const bytes = Buffer.from(pdfBase64, 'base64');
  if (bytes.length < config.s3.minBytes) {
    throw badRequest('El documento es demasiado pequeño para ser un PDF', {
      details: { field: 'pdf_base64', size: bytes.length, min: config.s3.minBytes },
    });
  }
  if (bytes.length > config.s3.maxBytes) {
    throw payloadTooLarge('El documento excede el tamaño máximo permitido', {
      details: { size: bytes.length, max: config.s3.maxBytes },
    });
  }
  if (bytes.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
    throw badRequest('El contenido no es un PDF', { details: { field: 'pdf_base64' } });
  }
  return bytes;
}

export async function submitConsent(body, { sourceIp, operatorId, receivedAtIso, requestId }) {
  requireObject(body, 'body');
  const log = requireObject(body.log, 'log');

  if (log.event_type !== 'CONSENT_SIGNED') {
    throw badRequest('POST /consents solo registra firmas (event_type CONSENT_SIGNED)', {
      details: { field: 'log.event_type', value: log.event_type },
    });
  }
  const registered = log.signature_data?.pdf_sha256;
  if (!isHex64(registered)) {
    throw badRequest('El log de una firma debe traer "signature_data.pdf_sha256"', {
      details: { field: 'log.signature_data.pdf_sha256' },
    });
  }

  // --- 0. el documento, y su hash contra el que el dispositivo declaró ----------
  const pdf = decodePdf(body.pdf_base64);
  const actualHex = createHash('sha256').update(pdf).digest('hex');
  if (actualHex !== registered.toLowerCase()) {
    // El log dice que se firmó un documento y el cuerpo trae otro. No se
    // guarda nada: ni el uno ni el otro son evidencia de nada.
    logger.warn('el PDF no corresponde con el hash del log', { consent_id: log.consent_id, request_id: requestId });
    throw badRequest('El documento no corresponde con el hash registrado en el log', {
      code: 'pdf_hash_mismatch',
      details: { registered_sha256: registered, actual_sha256: actualHex },
    });
  }

  const key = buildPdfKey(log.consent_id, log.timestamp_utc);
  const { consentId, points, payload, event } = buildSignedEvent(
    log,
    { sourceIp, operatorId, receivedAtIso },
    { captureMetadata: { pdf_s3_bucket: config.s3.bucket, pdf_s3_key: key } },
  );

  // --- 1. el PDF -----------------------------------------------------------------
  const stored = await s3.putPdfOnce({ key, body: pdf, checksumBase64: hexToBase64(actualHex) });
  if (!stored.created) {
    const existingHex = stored.checksumBase64 ? base64ToHex(stored.checksumBase64) : null;
    if (existingHex !== actualHex) {
      logger.warn('ya hay otro PDF bajo esa clave', { consent_id: consentId, key, request_id: requestId });
      throw conflict('El identificador de consentimiento ya tiene otro documento', { code: 'pdf_conflict' });
    }
    // Mismo documento: es un reintento que se quedó a medias. Se sigue.
  }

  // --- 2. el evento de la firma ---------------------------------------------------
  const signed = await evidence.putEventOnce({ consentId, seq: 1, type: 'CONSENT_SIGNED', event });
  let duplicate = false;
  if (!signed.created) {
    const existingLogId = signed.existing?.event?.payload?.log_id ?? null;
    if (!existingLogId || existingLogId !== log.log_id) {
      logger.warn('consent_id ya utilizado por otro log', {
        consent_id: consentId,
        log_id: log.log_id,
        existing_log_id: existingLogId,
        request_id: requestId,
      });
      throw conflict('El identificador de consentimiento ya está registrado con otro contenido');
    }
    duplicate = true;
  }
  const signedSha256 = signed.created ? signed.sha256 : signed.existing.sha256;

  // --- 3. la verificación, como evento propio ----------------------------------------
  // Lo verificado es lo que S3 tiene, no lo que este proceso cree que envió:
  // el checksum que S3 registró al guardar (o el del objeto que ya estaba).
  const verifiedEvent = {
    schema: EVENT_SCHEMA,
    seq: 2,
    event_type: 'PDF_VERIFIED',
    consent_id: consentId,
    recorded_at_utc: new Date().toISOString(),
    prev_hash: signedSha256,
    payload: {
      verified: true,
      bucket: stored.bucket,
      key: stored.key,
      size_bytes: stored.sizeBytes ?? pdf.length,
      checksum_sha256: stored.checksumBase64 ? base64ToHex(stored.checksumBase64) : actualHex,
      registered_sha256: registered.toLowerCase(),
    },
  };
  const verified = await evidence.putEventOnce({ consentId, seq: 2, type: 'PDF_VERIFIED', event: verifiedEvent });
  const verifiedSha256 = verified.created ? verified.sha256 : verified.existing.sha256;

  // --- 4. el índice -----------------------------------------------------------------------
  if (signed.created) await writePointers(payload, consentId);

  logger.info(duplicate ? 'consentimiento reenviado (ya registrado)' : 'consentimiento registrado y verificado', {
    consent_id: consentId,
    log_id: log.log_id,
    key,
    size_bytes: pdf.length,
    biometric_points: points,
    signed_sha256: signedSha256,
    verified_sha256: verifiedSha256,
    request_id: requestId,
    duplicate,
  });

  return {
    consentId,
    logId: log.log_id ?? null,
    duplicate,
    pdf: { bucket: stored.bucket, key: stored.key, sha256: actualHex, sizeBytes: pdf.length },
    events: { signed: signedSha256, verified: verifiedSha256 },
  };
}
