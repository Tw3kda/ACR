import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import config from '../config/env.js';
import logger from '../lib/logger.js';

/**
 * El registro de auditoría: objetos inmutables en S3 bajo Object Lock.
 *
 * Un consentimiento es una secuencia de eventos, cada uno un objeto:
 *
 *   events/<consent_id>/0001-CONSENT_SIGNED.json     el log que envía la app
 *   events/<consent_id>/0002-PDF_VERIFIED.json       lo que comprobó el verificador
 *
 * y tres punteros vacíos cuya clave es la consulta, para listar sin base de datos:
 *
 *   index/patient/<cédula>/<fecha>_<consent_id>
 *   index/clinic/<sede>/<fecha>_<consent_id>
 *   index/date/<aaaa>/<mm>/<dd>/<consent_id>
 *
 * Dos propiedades que este adaptador garantiza y de las que depende todo lo demás:
 *
 * - **Se escribe una sola vez.** `If-None-Match: *` hace que S3 rechace con 412
 *   cualquier segunda escritura sobre la misma clave. Es la idempotencia del
 *   outbox de la tablet, y es atómica: dos reenvíos simultáneos, uno gana.
 * - **El hash es reproducible.** El JSON se serializa con las claves ordenadas y
 *   el SHA-256 se calcula sobre esos bytes exactos, que son los que S3 guarda.
 *   Quien descargue el objeto y ejecute `sha256sum` obtiene el mismo valor.
 *
 * La retención no se fija aquí: la aplica el bucket a cada objeto al recibirlo.
 * Así ningún código puede "olvidarse" de bloquear un evento.
 */

let client;
const getClient = () => {
  client ??= new S3Client({
    region: config.evidence.region,
    endpoint: config.evidence.endpoint,
    forcePathStyle: config.evidence.forcePathStyle,
  });
  return client;
};

export const driver = 'aws';

const { bucket, eventsPrefix, indexPrefix } = config.evidence;

/** JSON con las claves ordenadas en todos los niveles: mismo objeto, mismos bytes. */
export function canonicalJson(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256Base64 = (bytes) => createHash('sha256').update(bytes).digest('base64');

export const eventKey = (consentId, seq, type) =>
  `${eventsPrefix}/${consentId}/${String(seq).padStart(4, '0')}-${type}.json`;

const isPrecondition = (err) => err?.$metadata?.httpStatusCode === 412 || err?.name === 'PreconditionFailed';
const isNoSuchKey = (err) => err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;

/**
 * Escribe un evento si y solo si la clave no existe.
 *
 * Devuelve `{ created: true, sha256 }` o, si ya había uno,
 * `{ created: false, existing: { event, sha256 } }` con lo que hay en S3 —
 * el llamador decide si es un reenvío inofensivo o un conflicto.
 */
export async function putEventOnce({ consentId, seq, type, event }) {
  const key = eventKey(consentId, seq, type);
  const body = Buffer.from(canonicalJson(event), 'utf8');

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        // S3 recalcula y rechaza si no coincide. Un bucket con Object Lock
        // además EXIGE un checksum en cada PutObject.
        ChecksumSHA256: sha256Base64(body),
        IfNoneMatch: '*',
      }),
    );
    logger.debug('evento escrito', { key, bytes: body.length });
    return { created: true, key, sha256: sha256Hex(body) };
  } catch (err) {
    if (!isPrecondition(err)) throw err;
    const existing = await getEvent(consentId, seq, type);
    return { created: false, key, existing };
  }
}

/** Un evento y el SHA-256 de sus bytes tal como están en S3. null si no existe. */
export async function getEvent(consentId, seq, type) {
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: eventKey(consentId, seq, type) }),
    );
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    return { event: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
  } catch (err) {
    if (isNoSuchKey(err)) return null;
    throw err;
  }
}

/**
 * Objeto vacío cuya clave es la consulta. Listar por prefijo devuelve los
 * consentimientos ordenados por fecha, en milisegundos, sin base de datos.
 * Idempotente: un puntero repetido no es un error.
 */
export async function putPointer(key) {
  const fullKey = `${indexPrefix}/${key}`;
  const empty = Buffer.alloc(0);
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: fullKey,
        Body: empty,
        ChecksumSHA256: sha256Base64(empty),
        IfNoneMatch: '*',
      }),
    );
  } catch (err) {
    if (!isPrecondition(err)) throw err;
  }
  return fullKey;
}

/** Claves bajo un prefijo del índice, ordenadas como S3 las devuelve (lexicográfico = cronológico). */
export async function listPointers(prefix, { limit = 100, continuationToken } = {}) {
  const res = await getClient().send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${indexPrefix}/${prefix}`,
      MaxKeys: limit,
      ContinuationToken: continuationToken,
    }),
  );
  return {
    keys: (res.Contents ?? []).map((o) => o.Key.slice(indexPrefix.length + 1)),
    nextToken: res.NextContinuationToken ?? null,
  };
}
