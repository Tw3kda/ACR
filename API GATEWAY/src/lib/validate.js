import { badRequest } from './errors.js';

const HEX64 = /^[0-9a-f]{64}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
// Sirve para construir una clave de S3 y una llave de DynamoDB: nada de `/`, `..`
// ni caracteres de control.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
export const isHex64 = (v) => typeof v === 'string' && HEX64.test(v);
export const isIsoUtc = (v) => typeof v === 'string' && ISO_UTC.test(v);
export const isSafeId = (v) => typeof v === 'string' && SAFE_ID.test(v);
export const isEmail = (v) => typeof v === 'string' && EMAIL.test(v) && v.length <= 254;

/** Normaliza el correo igual que la app: recortado y en minúsculas. */
export const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export function requireObject(value, field) {
  if (!isPlainObject(value)) throw badRequest(`Falta el objeto "${field}"`, { details: { field } });
  return value;
}

export function requireString(value, field, { max = 512 } = {}) {
  if (!isNonEmptyString(value)) throw badRequest(`Falta el campo "${field}"`, { details: { field } });
  if (value.length > max) {
    throw badRequest(`El campo "${field}" excede el tamaño permitido`, { details: { field, max } });
  }
  return value;
}

/**
 * Cuenta los puntos biométricos sin recorrer estructuras absurdas: es la entrada
 * más grande del ítem y la única que puede acercarse al límite de 400 KB.
 */
export function countBiometricPoints(biometrics) {
  if (!isPlainObject(biometrics) || !Array.isArray(biometrics.strokes)) return 0;
  let total = 0;
  for (const stroke of biometrics.strokes) {
    if (isPlainObject(stroke) && Array.isArray(stroke.points)) total += stroke.points.length;
  }
  return total;
}
