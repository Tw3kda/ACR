import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectAttributesCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import config from '../config/env.js';

let client;
const getClient = () => {
  client ??= new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: config.s3.forcePathStyle,
  });
  return client;
};

export const driver = 'aws';

/**
 * Guarda el PDF, una sola vez por clave.
 *
 * El checksum viaja con el objeto: S3 vuelve a calcular el SHA-256 del cuerpo y
 * rechaza con `BadDigest` si no coincide. Es la segunda verificación (la
 * primera la hace el servicio antes de llamar aquí) y la hace quien custodia
 * los bytes, no quien los envía.
 *
 * `If-None-Match: *` hace que S3 rechace con 412 si la clave ya existe. Un
 * reintento del mismo consentimiento cae ahí, y el servicio decide si el objeto
 * existente es el mismo (checksum igual: seguir) u otro (conflicto).
 */
export async function putPdfOnce({ key, body, checksumBase64 }) {
  const input = {
    Bucket: config.s3.bucket,
    Key: key,
    Body: body,
    ContentType: 'application/pdf',
    ContentLength: body.length,
    ChecksumSHA256: checksumBase64,
    IfNoneMatch: '*',
  };
  if (config.s3.kmsKeyId) {
    input.ServerSideEncryption = 'aws:kms';
    input.SSEKMSKeyId = config.s3.kmsKeyId;
  }

  try {
    await getClient().send(new PutObjectCommand(input));
    return { created: true, bucket: config.s3.bucket, key, sizeBytes: body.length, checksumBase64 };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode !== 412 && err?.name !== 'PreconditionFailed') throw err;
    const existing = await getObjectAttributes({ bucket: config.s3.bucket, key });
    return { created: false, bucket: config.s3.bucket, key, ...existing };
  }
}

/** Checksum y tamaño reales de un objeto ya almacenado, según S3. */
export async function getObjectAttributes({ bucket, key }) {
  const res = await getClient().send(
    new GetObjectAttributesCommand({
      Bucket: bucket,
      Key: key,
      ObjectAttributes: ['Checksum', 'ObjectSize'],
    }),
  );
  return {
    checksumBase64: res.Checksum?.ChecksumSHA256 ?? null,
    sizeBytes: res.ObjectSize ?? null,
  };
}

/**
 * URL firmada de lectura para la web de consulta. Los bytes van de S3 al
 * navegador sin pasar por Lambda (límite de 6 MB) y sin necesitar CORS: el
 * navegador *navega* a la URL, no hace fetch.
 *
 * `inline` abre el PDF en el visor del navegador; sin él, S3 responde con
 * `Content-Disposition: attachment` y el navegador descarga.
 *
 * El permiso se evalúa contra quien firma (el rol de la Lambda): s3:GetObject
 * sobre la clave (y kms:Decrypt si el bucket usa una CMK).
 */
export async function presignPdfGet({ bucket, key, filename, inline = false }) {
  const expiresIn = config.s3.downloadUrlTtlSeconds;
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: bucket ?? config.s3.bucket,
      Key: key,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    }),
    { expiresIn },
  );
  return { url, expiresIn, filename: safeName };
}
