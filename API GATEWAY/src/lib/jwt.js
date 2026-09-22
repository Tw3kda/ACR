/**
 * Decodificación sin verificación de firma.
 *
 * Solo se usa en dos sitios legítimos:
 *  1. Sobre el IdToken que Cognito acaba de emitir dentro de esta misma llamada
 *     (no hay canal por el que un tercero lo hubiera podido manipular).
 *  2. En desarrollo, cuando no hay JWT authorizer delante (AUTH_CLAIMS_SOURCE=local).
 *
 * En producción las claims de las rutas protegidas vienen del authorizer del
 * gateway, que sí verifica firma, emisor, audiencia y expiración.
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    return typeof payload === 'object' && payload !== null ? payload : null;
  } catch {
    return null;
  }
}

/** Devuelve true si el `exp` del token ya pasó (con margen de holgura). */
export function isExpired(payload, skewSeconds = 0) {
  if (!payload || typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 <= Date.now() - skewSeconds * 1000;
}

export function bearerFrom(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1].trim() : null;
}
