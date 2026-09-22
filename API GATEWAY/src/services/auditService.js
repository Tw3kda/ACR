import config from '../config/env.js';
import { evidence } from '../aws/index.js';
import { badRequest, conflict, payloadTooLarge } from '../lib/errors.js';
import {
  countBiometricPoints,
  isHex64,
  isIsoUtc,
  isPlainObject,
  isSafeId,
  requireObject,
} from '../lib/validate.js';
import logger from '../lib/logger.js';

/** Versión del sobre que envuelve cada evento. El payload es el log tal como lo define el contrato. */
export const EVENT_SCHEMA = 'acr.consent.event/1';

export function validate(body) {
  requireObject(body, 'body');

  const consentId = body.consent_id;
  if (!isSafeId(consentId)) {
    throw badRequest('El campo "consent_id" es obligatorio y no admite caracteres especiales', {
      details: { field: 'consent_id' },
    });
  }

  if (!config.audit.allowedEventTypes.includes(body.event_type)) {
    throw badRequest('Tipo de evento no reconocido', {
      details: { field: 'event_type', value: body.event_type },
    });
  }

  if (!isIsoUtc(body.timestamp_utc)) {
    throw badRequest('El campo "timestamp_utc" debe ser una fecha ISO-8601 en UTC', {
      details: { field: 'timestamp_utc' },
    });
  }

  const subject = requireObject(body.subject, 'subject');
  if (!isSafeId(subject.patient_id)) {
    throw badRequest('El campo "subject.patient_id" es obligatorio', {
      details: { field: 'subject.patient_id' },
    });
  }

  const signature = requireObject(body.signature_data, 'signature_data');
  // `pdf_sha256` vacío es el caso web sin archivo; si viene, tiene que ser
  // exactamente 64 hex o la firma de la URL de S3 no se podrá construir.
  const pdfHash = signature.pdf_sha256;
  if (pdfHash !== undefined && pdfHash !== null && pdfHash !== '' && !isHex64(pdfHash)) {
    throw badRequest('El campo "signature_data.pdf_sha256" debe ser un SHA-256 en hexadecimal', {
      details: { field: 'signature_data.pdf_sha256' },
    });
  }
  for (const field of ['image_sha256', 'document_hash_sha256', 'template_hash_sha256']) {
    const value = signature[field];
    if (value !== undefined && value !== null && value !== '' && !isHex64(value)) {
      throw badRequest(`El campo "signature_data.${field}" debe ser un SHA-256 en hexadecimal`, {
        details: { field: `signature_data.${field}` },
      });
    }
  }

  if (body.biometrics_json !== undefined && !isPlainObject(body.biometrics_json)) {
    throw badRequest('El campo "biometrics_json" debe ser un objeto');
  }

  const points = countBiometricPoints(body.biometrics_json);
  if (points > config.audit.maxBiometricPoints) {
    throw payloadTooLarge('La firma biométrica excede el tamaño permitido', {
      details: { points, max: config.audit.maxBiometricPoints },
    });
  }

  return { consentId, points };
}

/** `2026-09-12T06:04:55.448Z` → `2026-09-12T06-04-55Z`: ordenable y válido en una clave. */
const stampForKey = (iso) => iso.slice(0, 19).replace(/:/g, '-') + 'Z';

/** Los tres punteros del índice. Un fallo aquí no invalida el evento, que ya está escrito. */
export async function writePointers(payload, consentId) {
  const stamp = stampForKey(payload.timestamp_utc);
  const [y, m, d] = payload.timestamp_utc.slice(0, 10).split('-');
  const clinic = payload.capture_metadata?.clinic_location_id;

  const keys = [
    `patient/${payload.subject.patient_id}/${stamp}_${consentId}`,
    clinic && isSafeId(clinic) ? `clinic/${clinic}/${stamp}_${consentId}` : null,
    `date/${y}/${m}/${d}/${consentId}`,
  ].filter(Boolean);

  const results = await Promise.allSettled(keys.map((k) => evidence.putPointer(k)));
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      logger.error('no se pudo escribir un puntero del índice', { key: keys[i], error: r.reason?.name });
    }
  }
}

/**
 * El evento 0001 tal como se escribirá, a partir del log que envió el
 * dispositivo. Lo que el dispositivo no debe decidir se sobrescribe aquí: todo
 * lo que viene del cuerpo es una *afirmación del cliente*; lo que se guarda
 * como hecho es lo que aporta la infraestructura.
 *
 * `overrides` es para lo que el servidor sabe y el cliente solo predijo: la
 * clave real del PDF, por ejemplo.
 */
export function buildSignedEvent(body, { sourceIp, operatorId, receivedAtIso }, overrides = {}) {
  const { consentId, points } = validate(body);

  // El cuerpo viene con las llaves de DynamoDB de la fase anterior; ya no
  // significan nada aquí y no se guardan.
  const { PK, SK, GSI1_PK, GSI1_SK, GSI2_PK, GSI2_SK, ...log } = body;

  const payload = {
    ...log,
    device_context: {
      ...(isPlainObject(log.device_context) ? log.device_context : {}),
      // La app la manda en null a propósito: solo ve su IP de LAN.
      ip_address: sourceIp ?? null,
    },
    capture_metadata: {
      ...(isPlainObject(log.capture_metadata) ? log.capture_metadata : {}),
      // La identidad autenticada manda sobre lo que diga el cuerpo.
      operator_id: operatorId,
      ...(overrides.captureMetadata ?? {}),
    },
    // El reloj del gateway, no el de la tablet.
    received_at_utc: receivedAtIso,
  };

  const event = {
    schema: EVENT_SCHEMA,
    seq: 1,
    event_type: body.event_type,
    consent_id: consentId,
    recorded_at_utc: receivedAtIso,
    prev_hash: null,
    payload,
  };

  return { consentId, points, payload, event };
}

/**
 * Registra un evento de auditoría que NO es una firma (vista, rechazo,
 * revocación). La firma entra por `POST /consents`, con su PDF, en
 * consentService: un CONSENT_SIGNED sin documento no es un consentimiento.
 *
 * El evento se escribe en S3 una sola vez por consent_id. Un reenvío del outbox
 * con el mismo log_id es un duplicado inofensivo; otro log bajo el mismo id es
 * un conflicto, porque la clave del objeto ES el id.
 */
export async function storeAuditLog(body, { sourceIp, operatorId, receivedAtIso, requestId }) {
  if (body?.event_type === 'CONSENT_SIGNED') {
    throw badRequest('Una firma se registra con su documento en POST /consents', {
      details: { field: 'event_type', use: 'POST /consents' },
    });
  }

  const { consentId, points, payload, event } = buildSignedEvent(body, { sourceIp, operatorId, receivedAtIso });

  const result = await evidence.putEventOnce({ consentId, seq: 1, type: body.event_type, event });

  if (!result.created) {
    const existingLogId = result.existing?.event?.payload?.log_id ?? null;
    if (existingLogId && existingLogId === body.log_id) {
      logger.info('log de auditoría duplicado (reenvío)', {
        consent_id: consentId,
        log_id: body.log_id,
        request_id: requestId,
        duplicate: true,
      });
      return { created: false, logId: body.log_id, consentId, eventSha256: result.existing.sha256 };
    }
    logger.warn('consent_id ya utilizado por otro log', {
      consent_id: consentId,
      log_id: body.log_id,
      existing_log_id: existingLogId,
      request_id: requestId,
    });
    throw conflict('El identificador de consentimiento ya está registrado con otro contenido');
  }

  await writePointers(payload, consentId);

  logger.info('log de auditoría almacenado', {
    consent_id: consentId,
    log_id: body.log_id,
    event_type: body.event_type,
    biometric_points: points,
    event_sha256: result.sha256,
    request_id: requestId,
    duplicate: false,
  });

  return { created: true, logId: body.log_id ?? null, consentId, eventSha256: result.sha256 };
}
