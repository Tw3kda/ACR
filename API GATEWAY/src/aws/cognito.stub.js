import crypto from 'node:crypto';

import config from '../config/env.js';
import logger from '../lib/logger.js';
import { traceAws } from '../lib/trace.js';

/**
 * Cognito simulado, en memoria. Existe para que la app se pueda integrar contra
 * el API completo antes de que el user pool exista.
 *
 * Emite JWT con estructura real pero **firma inventada**: sirven para que el
 * cliente los guarde y los mande como Bearer, y para que este mismo proceso los
 * decodifique en modo AUTH_CLAIMS_SOURCE=local. No valen para nada más. La
 * comprobación de `assertDeployable()` impide que esto llegue a producción.
 */

const users = new Map(); // email -> { sub, email, name, password }

function seed() {
  const email = config.stub.seedEmail.toLowerCase();
  if (users.has(email)) return;
  users.set(email, {
    sub: crypto.randomUUID(),
    email,
    name: config.stub.seedName,
    password: config.stub.seedPassword,
  });
}
seed();

class StubCognitoError extends Error {
  constructor(name) {
    super(name);
    this.name = name;
  }
}

const b64u = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

function issueToken(user, tokenUse, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u({ alg: 'none', kid: 'stub', typ: 'JWT' });
  const payload = b64u({
    sub: user.sub,
    email: user.email,
    name: user.name,
    token_use: tokenUse,
    iss: `https://stub.local/${config.cognito.userPoolId || 'stub-pool'}`,
    client_id: config.cognito.clientId || 'stub-client',
    scope: 'aws.cognito.signin.user.admin',
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  });
  return `${header}.${payload}.stub-signature-not-verifiable`;
}

function session(user) {
  const ttl = 12 * 60 * 60; // igual que la vigencia prevista en producción
  return {
    authenticationResult: {
      AccessToken: issueToken(user, 'access', ttl),
      IdToken: issueToken(user, 'id', ttl),
      RefreshToken: `stub-refresh.${Buffer.from(user.email).toString('base64url')}`,
      ExpiresIn: ttl,
      TokenType: 'Bearer',
    },
    challengeName: null,
  };
}

export const driver = 'stub';

export async function initiateAuthWithPassword({ username, password }) {
  traceAws({
    service: 'Cognito',
    operation: 'AdminInitiateAuth',
    note: 'ADMIN_USER_PASSWORD_AUTH',
    input: {
      UserPoolId: config.cognito.userPoolId || '«COGNITO_USER_POOL_ID sin definir»',
      ClientId: config.cognito.clientId || '«COGNITO_CLIENT_ID sin definir»',
      AuthFlow: config.cognito.authFlow,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: config.cognito.clientSecret ? '«calculado»' : '(el client no tiene secreto)',
      },
    },
  });

  const user = users.get(String(username).toLowerCase());
  if (!user || user.password !== password) throw new StubCognitoError('NotAuthorizedException');
  logger.debug('cognito stub: login', { username });
  return session(user);
}

export async function initiateAuthWithRefreshToken({ refreshToken, username }) {
  traceAws({
    service: 'Cognito',
    operation: 'AdminInitiateAuth',
    note: 'REFRESH_TOKEN_AUTH',
    input: {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
        SECRET_HASH: config.cognito.clientSecret
          ? `«calculado sobre username=${username ?? 'DESCONOCIDO'}»`
          : '(el client no tiene secreto)',
      },
    },
  });

  const prefix = 'stub-refresh.';
  if (typeof refreshToken !== 'string' || !refreshToken.startsWith(prefix)) {
    throw new StubCognitoError('NotAuthorizedException');
  }
  const email = Buffer.from(refreshToken.slice(prefix.length), 'base64url').toString('utf8');
  const user = users.get(email);
  if (!user) throw new StubCognitoError('NotAuthorizedException');
  const result = session(user);
  // Cognito no rota el refresh token salvo que se active; se replica ese comportamiento.
  result.authenticationResult.RefreshToken = undefined;
  return result;
}

export async function adminCreateUser({ username, email, name }) {
  traceAws({
    service: 'Cognito',
    operation: 'AdminCreateUser',
    note: 'sin correo de invitación',
    input: {
      UserPoolId: config.cognito.userPoolId || '«COGNITO_USER_POOL_ID sin definir»',
      Username: username,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        ...(name ? [{ Name: 'name', Value: name }] : []),
      ],
    },
  });

  const key = String(email ?? username).toLowerCase();
  if (users.has(key)) throw new StubCognitoError('UsernameExistsException');
  users.set(key, { sub: crypto.randomUUID(), email: key, name: name ?? '', password: null });
  return { username: key };
}

export async function adminSetPassword({ username, password }) {
  traceAws({
    service: 'Cognito',
    operation: 'AdminSetUserPassword',
    input: { Username: username, Password: password, Permanent: true },
  });

  const user = users.get(String(username).toLowerCase());
  if (!user) throw new StubCognitoError('UserNotFoundException');
  user.password = password;
}

export async function adminGetUser({ username }) {
  const user = users.get(String(username).toLowerCase());
  if (!user) throw new StubCognitoError('UserNotFoundException');
  return { username: user.email, sub: user.sub, email: user.email, name: user.name, status: 'CONFIRMED' };
}

/** Solo para las pruebas de humo. */
export const __store = users;
