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

const { eventsPrefix, indexPrefix, accessPrefix } = config.evidence;
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

export async function putAccessRecord({ patientId, name, record }) {
  const key = `${accessPrefix}/${patientId}/${name}.json`;
  const body = Buffer.from(canonicalJson(record), 'utf8');

  traceAws({
    service: 'S3',
    operation: 'PutObject',
    note: 'registro de acceso de la web de consulta',
    input: { Bucket: bucket, Key: key, IfNoneMatch: '*', Body: record },
  });

  objects.set(key, body);
  return { key, sha256: sha256Hex(body) };
}

export async function listAccessRecords(patientId, { limit = 200 } = {}) {
  const prefix = `${accessPrefix}/${patientId}/`;
  return [...objects.keys()]
    .filter((k) => k.startsWith(prefix))
    .sort()
    .slice(-limit)
    .map((k) => JSON.parse(objects.get(k).toString('utf8')));
}

export async function putJsonOnce(key, value) {
  const body = Buffer.from(canonicalJson(value), 'utf8');
  const created = !objects.has(key);
  traceAws({
    service: 'S3',
    operation: 'PutObject',
    note: created ? 'objeto nuevo (queda bajo Object Lock)' : 'la clave ya existe (412)',
    input: { Bucket: bucket, Key: key, IfNoneMatch: '*' },
  });
  if (!created) return { created: false, key, existing: await getJson(key) };
  objects.set(key, body);
  return { created: true, key, sha256: sha256Hex(body) };
}

export async function getJson(key) {
  const bytes = objects.get(key);
  if (!bytes) return null;
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
}

export async function listKeys(prefix) {
  return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
}

export async function listPatientIds() {
  const prefix = `${indexPrefix}/patient/`;
  const ids = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]);
  return [...new Set(ids)].sort();
}

export async function listEvents(consentId) {
  const prefix = `${eventsPrefix}/${consentId}/`;
  return [...objects.keys()]
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((key) => {
      const bytes = objects.get(key);
      return { key, event: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
    });
}

/** Solo para las pruebas de humo. */
export const __store = objects;
