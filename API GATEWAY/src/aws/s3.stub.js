import config from '../config/env.js';
import { traceAws } from '../lib/trace.js';

/**
 * S3 simulado: los PDFs se quedan en memoria, con la misma semántica de
 * escritura única que el adaptador real (412 si la clave existe).
 */

const objects = new Map(); // key -> { body, checksumBase64, sizeBytes }

export const driver = 'stub';

const bucket = () => config.s3.bucket || 'stub-consent-pdfs';

export async function putPdfOnce({ key, body, checksumBase64 }) {
  const existing = objects.get(key);

  traceAws({
    service: 'S3',
    operation: 'PutObject',
    note: existing ? 'la clave ya existe: 412 PreconditionFailed' : `${body.length} bytes, queda bajo Object Lock`,
    input: {
      Bucket: bucket(),
      Key: key,
      ContentType: 'application/pdf',
      ContentLength: body.length,
      ChecksumSHA256: checksumBase64,
      IfNoneMatch: '*',
      ...(config.s3.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: config.s3.kmsKeyId } : {}),
    },
  });

  if (existing) {
    return { created: false, bucket: bucket(), key, checksumBase64: existing.checksumBase64, sizeBytes: existing.sizeBytes };
  }

  objects.set(key, { body: Buffer.from(body), checksumBase64, sizeBytes: body.length });
  return { created: true, bucket: bucket(), key, sizeBytes: body.length, checksumBase64 };
}

export async function getObjectAttributes({ bucket: b, key }) {
  const entry = objects.get(key);
  const output = entry
    ? { checksumBase64: entry.checksumBase64, sizeBytes: entry.sizeBytes }
    : { checksumBase64: null, sizeBytes: null };

  traceAws({
    service: 'S3',
    operation: 'GetObjectAttributes',
    note: entry ? undefined : 'no existe esa clave en esta ejecución',
    input: { Bucket: b ?? bucket(), Key: key, ObjectAttributes: ['Checksum', 'ObjectSize'] },
    output,
  });

  return output;
}

/** Solo para las pruebas de humo. */
export const __store = objects;
