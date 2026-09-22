/**
 * Sobre del refresh token.
 *
 * El problema: con un app client **con secreto**, `REFRESH_TOKEN_AUTH` exige
 * `SECRET_HASH`, y `SECRET_HASH` se calcula sobre el *username*. La app solo
 * envía `{ "refresh_token": "..." }` — el username no viaja por ninguna parte, y
 * el refresh token de Cognito es opaco (no se puede sacar de ahí).
 *
 * La solución de menor fricción, sin tocar la app y sin estado nuevo en el
 * backend: envolver el refresh token junto al username en un blob base64url que
 * la app trata como una cadena opaca cualquiera.
 *
 * Sobre la seguridad de esto: el sobre **no es un secreto adicional**. Solo
 * contiene el username (que el propio dueño de la sesión ya conoce: es su
 * correo) y su refresh token (que ya era suyo). Manipularlo no da acceso a
 * nada — con otro username el SECRET_HASH no cuadra y Cognito devuelve 401.
 *
 * Alternativas si esto no convence: (a) app client sin secreto —el dispositivo
 * nunca ve el secreto porque quien llama es el Lambda, así que el secreto aporta
 * poco aquí—, o (b) tabla `refresh_sessions` con TTL que mapee un handle opaco
 * al par (username, refresh token). Configurable con COGNITO_REFRESH_USERNAME_MODE.
 */

const PREFIX = 'v1.';

export function packRefreshToken(refreshToken, username) {
  if (!refreshToken) return refreshToken;
  if (!username) return refreshToken;
  const json = JSON.stringify({ u: username, rt: refreshToken });
  return PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Acepta tanto un sobre como un refresh token de Cognito pelado (por si quedan
 * sesiones antiguas o se cambia de modo sin invalidar sesiones).
 */
export function unpackRefreshToken(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
    return { refreshToken: value, username: null };
  }
  try {
    const json = Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.rt === 'string') {
      return { refreshToken: parsed.rt, username: typeof parsed.u === 'string' ? parsed.u : null };
    }
  } catch {
    /* cae al retorno de abajo */
  }
  return { refreshToken: value, username: null };
}
