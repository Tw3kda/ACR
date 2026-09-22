import { S3Client, PutObjectCommand, GetObjectAttributesCommand } from '@aws-sdk/client-s3';

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
