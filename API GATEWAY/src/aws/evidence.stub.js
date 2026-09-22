import { createHash } from 'node:crypto';

import config from '../config/env.js';
import logger from '../lib/logger.js';
import { traceAws } from '../lib/trace.js';

/**
 * Registro de evidencia simulado en memoria. Misma superficie que
 * evidence.aws.js y el mismo comportamiento en lo que importa: escribir una
 * sola vez por clave, hash sobre los bytes canónicos, punteros idempotentes.
 * Se pierde en cada arranque — es un simulador, no un almacén.
 */

const objects = new Map(); // clave -> Buffer

export const driver = 'stub';

export function canonicalJson(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const { eventsPrefix, indexPrefix } = config.evidence;
const bucket = config.evidence.bucket || 'stub-consent-evidence';

export const eventKey = (consentId, seq, type) =>
  `${eventsPrefix}/${consentId}/${String(seq).padStart(4, '0')}-${type}.json`;

export async function putEventOnce({ consentId, seq, type, event }) {
  const key = eventKey(consentId, seq, type);
  const body = Buffer.from(canonicalJson(event), 'utf8');
  const created = !objects.has(key);

  traceAws({
    service: 'S3',
    operation: 'PutObject',
    note: created ? 'evento nuevo (queda bajo Object Lock)' : 'If-None-Match fallaría: la clave ya existe (412)',
    input: { Bucket: bucket, Key: key, IfNoneMatch: '*', ChecksumSHA256: '<sha256 del cuerpo>', Body: event },
    output: { created },
  });

  if (!created) return { created: false, key, existing: await getEvent(consentId, seq, type) };
  objects.set(key, body);
  logger.debug('evidence stub: evento guardado', { key, total: objects.size });
  return { created: true, key, sha256: sha256Hex(body) };
}

export async function getEvent(consentId, seq, type) {
  const bytes = objects.get(eventKey(consentId, seq, type));
  if (!bytes) return null;
  return { event: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
}

export async function putPointer(key) {
  const fullKey = `${indexPrefix}/${key}`;
  if (!objects.has(fullKey)) objects.set(fullKey, Buffer.alloc(0));
  return fullKey;
}

export async function listPointers(prefix, { limit = 100 } = {}) {
  const full = `${indexPrefix}/${prefix}`;
  const keys = [...objects.keys()]
    .filter((k) => k.startsWith(full))
    .sort()
    .slice(0, limit)
    .map((k) => k.slice(indexPrefix.length + 1));
  return { keys, nextToken: null };
}

/** Solo para las pruebas de humo. */
export const __store = objects;
