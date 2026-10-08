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

/**
 * No hay S3 detrás: la "URL firmada" apunta a este mismo proceso, a una ruta
 * que solo existe con el adaptador simulado (ver app.js). Así la web de
 * consulta puede abrir y descargar PDFs en local igual que en AWS.
 */
export async function presignPdfGet({ bucket: b, key, filename, inline = false }) {
  const expiresIn = config.s3.downloadUrlTtlSeconds;
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`;

  traceAws({
    service: 'S3',
    operation: 'getSignedUrl(GetObjectCommand)',
    note: `caduca en ${expiresIn} s`,
    input: { Bucket: b ?? bucket(), Key: key, ResponseContentDisposition: disposition },
  });

  const params = new URLSearchParams({
    key,
    disposition,
    expires: String(Date.now() + expiresIn * 1000),
  });
  return {
    url: `http://localhost:${config.http.port}/__stub/s3/object?${params}`,
    expiresIn,
    filename: safeName,
  };
}

export async function getPdfBytes(key) {
  return objects.get(key)?.body ?? null;
}

/** Solo para las pruebas de humo. */
export const __store = objects;
