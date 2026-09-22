import crypto from 'node:crypto';

/**
 * SECRET_HASH = base64(HMAC-SHA256(username + clientId, clientSecret)).
 *
 * Omitirlo cuando el app client tiene secreto devuelve un NotAuthorizedException
 * idéntico al de una contraseña mala; es el error que más tiempo cuesta.
 */
export function secretHash(username, clientId, clientSecret) {
  if (!clientSecret) return undefined;
  return crypto
    .createHmac('sha256', clientSecret)
    .update(`${username}${clientId}`)
    .digest('base64');
}

/** Añade SECRET_HASH a los AuthParameters solo si hace falta. */
export function withSecretHash(authParameters, username, { clientId, clientSecret }) {
  const hash = secretHash(username, clientId, clientSecret);
  return hash ? { ...authParameters, SECRET_HASH: hash } : { ...authParameters };
}
