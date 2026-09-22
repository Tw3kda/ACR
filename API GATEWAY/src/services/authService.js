import config from '../config/env.js';
import { cognito } from '../aws/index.js';
import { AppError, badRequest, conflict, forbidden, serverError, unauthorized } from '../lib/errors.js';
import { decodeJwtPayload } from '../lib/jwt.js';
import { packRefreshToken, unpackRefreshToken } from '../lib/refreshEnvelope.js';
import { isEmail, normalizeEmail } from '../lib/validate.js';
import logger from '../lib/logger.js';

/**
 * Mensaje único para credenciales malas y usuario inexistente: distinguirlos
 * permite enumerar cuentas del personal clínico.
 */
const CREDENCIALES_INVALIDAS = 'Correo o contraseña incorrectos';
const SESION_EXPIRADA = 'La sesión expiró, vuelva a iniciar sesión';

/** Traduce los nombres de excepción de Cognito al contrato de la app. */
function mapCognitoError(err, { context }) {
  const name = err?.name ?? err?.__type ?? 'UnknownError';
  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return context === 'refresh'
        ? unauthorized(SESION_EXPIRADA, { details: { cognito: name } })
        : unauthorized(CREDENCIALES_INVALIDAS, { details: { cognito: name } });
    case 'PasswordResetRequiredException':
      return forbidden('Debe restablecer su contraseña', { details: { cognito: name } });
    case 'UserNotConfirmedException':
      return forbidden('La cuenta aún no está confirmada', { details: { cognito: name } });
    case 'UsernameExistsException':
      return conflict('Ya existe una cuenta con ese correo', { details: { cognito: name } });
    case 'InvalidPasswordException':
      return badRequest('La contraseña no cumple la política de seguridad', { details: { cognito: name } });
    case 'InvalidParameterException':
      return badRequest('Los datos enviados no son válidos', { details: { cognito: name } });
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return new AppError(429, 'Demasiados intentos, espere un momento', {
        code: 'too_many_requests',
        details: { cognito: name },
      });
    default:
      return serverError('No fue posible completar la operación', { details: { cognito: name }, cause: err });
  }
}

/**
 * El token que se devuelve a la app tiene que ser el que el JWT authorizer
 * valide después. Con un authorizer de HTTP API sobre access tokens, es el
 * AccessToken; si se configura para IdToken, cambiar COGNITO_TOKEN_FOR_APP.
 */
function pickAppToken(auth) {
  const preferIdToken = config.cognito.tokenForApp === 'id';
  const token = preferIdToken ? auth.IdToken : auth.AccessToken;
  return token ?? auth.AccessToken ?? auth.IdToken ?? null;
}

/**
 * El IdToken lo acaba de emitir Cognito en esta misma llamada, así que se puede
 * leer sin verificar firma: no hay canal por el que se hubiera podido manipular.
 */
function userFromTokens(auth, fallbackEmail) {
  const claims = decodeJwtPayload(auth.IdToken) ?? decodeJwtPayload(auth.AccessToken) ?? {};
  return {
    id: claims.sub ?? null,
    email: claims.email ?? fallbackEmail ?? null,
    name: claims.name ?? claims.given_name ?? null,
  };
}

function sessionResponse(auth, { email, username }) {
  const token = pickAppToken(auth);
  if (!token) throw serverError('Cognito no devolvió un token de sesión');

  const body = { token, user: userFromTokens(auth, email) };

  if (auth.RefreshToken) {
    body.refreshToken =
      config.cognito.refreshUsernameMode === 'envelope'
        ? packRefreshToken(auth.RefreshToken, username ?? email)
        : auth.RefreshToken;
  }
  if (Number.isFinite(auth.ExpiresIn)) body.expiresIn = auth.ExpiresIn;

  return body;
}

/**
 * Un `challenge` (NEW_PASSWORD_REQUIRED, MFA…) no es una sesión. La app no sabe
 * resolverlos, así que se corta aquí con un mensaje accionable en vez de
 * devolver una respuesta a medias.
 */
function rejectChallenge(challengeName) {
  if (!challengeName) return;
  if (challengeName === 'NEW_PASSWORD_REQUIRED') {
    throw forbidden('Debe restablecer su contraseña');
  }
  throw forbidden('La cuenta requiere un paso adicional de verificación', {
    details: { challengeName },
  });
}

export async function login({ email, password }) {
  const normalized = normalizeEmail(email);
  if (!isEmail(normalized) || typeof password !== 'string' || password === '') {
    // Mismo mensaje que unas credenciales malas: un 400 distinto también informa.
    throw unauthorized(CREDENCIALES_INVALIDAS, { details: { reason: 'formato' } });
  }

  let result;
  try {
    result = await cognito.initiateAuthWithPassword({ username: normalized, password });
  } catch (err) {
    throw mapCognitoError(err, { context: 'login' });
  }

  rejectChallenge(result.challengeName);
  if (!result.authenticationResult) throw unauthorized(CREDENCIALES_INVALIDAS);

  return sessionResponse(result.authenticationResult, { email: normalized, username: normalized });
}

export async function register({ email, password, name, inviteCode }) {
  if (!config.cognito.registrationEnabled) {
    // Ver "Hallazgo 3": el auto-registro abierto deja crear cuentas de personal
    // clínico a cualquiera que alcance el endpoint.
    throw forbidden('El registro de usuarios está deshabilitado. Solicite su cuenta al administrador');
  }

  const expected = config.cognito.registrationInviteCode;
  if (expected && inviteCode !== expected) {
    throw forbidden('Código de invitación inválido');
  }

  const normalized = normalizeEmail(email);
  if (!isEmail(normalized)) throw badRequest('El correo no es válido');
  if (typeof password !== 'string' || password.length < config.cognito.minPasswordLength) {
    throw badRequest(`La contraseña debe tener al menos ${config.cognito.minPasswordLength} caracteres`);
  }

  const displayName = typeof name === 'string' ? name.trim().slice(0, 128) : '';

  try {
    await cognito.adminCreateUser({ username: normalized, email: normalized, name: displayName });
    await cognito.adminSetPassword({ username: normalized, password });
  } catch (err) {
    throw mapCognitoError(err, { context: 'register' });
  }

  logger.info('usuario creado', { email: normalized });

  // La app inicia sesión de inmediato con lo que devuelve este endpoint, así que
  // el registro termina con una sesión ya abierta.
  return login({ email: normalized, password });
}

export async function refresh({ refreshToken: incoming, username: usernameFromBody }) {
  if (typeof incoming !== 'string' || incoming.trim() === '') {
    throw unauthorized(SESION_EXPIRADA, { details: { reason: 'refresh_token ausente' } });
  }

  const { refreshToken, username: usernameFromEnvelope } = unpackRefreshToken(incoming.trim());
  const username = usernameFromEnvelope ?? normalizeEmail(usernameFromBody) ?? null;

  if (config.cognito.refreshUsernameMode !== 'none' && !username) {
    // Sin username no hay SECRET_HASH válido. Se responde 401 (no 500): la app
    // cierra sesión y el usuario vuelve a entrar, que es la salida correcta.
    logger.warn('refresh sin username: el app client tiene secreto y el sobre no vino', {});
    throw unauthorized(SESION_EXPIRADA, { details: { reason: 'username no disponible' } });
  }

  let result;
  try {
    result = await cognito.initiateAuthWithRefreshToken({ refreshToken, username });
  } catch (err) {
    const mapped = mapCognitoError(err, { context: 'refresh' });
    // Cualquier fallo aquí cierra la sesión en la app: siempre 401 salvo 5xx real.
    throw mapped.status >= 500 ? mapped : unauthorized(SESION_EXPIRADA, { details: mapped.details });
  }

  rejectChallenge(result.challengeName);
  if (!result.authenticationResult) throw unauthorized(SESION_EXPIRADA);

  const auth = result.authenticationResult;
  const token = pickAppToken(auth);
  if (!token) throw unauthorized(SESION_EXPIRADA);

  const body = { token };
  // Cognito solo devuelve refresh token nuevo si la rotación está activada; si
  // no viene, la app conserva el que ya tenía.
  if (auth.RefreshToken) {
    body.refreshToken =
      config.cognito.refreshUsernameMode === 'envelope'
        ? packRefreshToken(auth.RefreshToken, username)
        : auth.RefreshToken;
  }
  if (Number.isFinite(auth.ExpiresIn)) body.expiresIn = auth.ExpiresIn;

  return body;
}
