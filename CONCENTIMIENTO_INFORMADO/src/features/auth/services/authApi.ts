import { apiConfig } from '@/services/api/config';
import { postJson, type ApiResult } from '@/services/apiClient';

export type LoginResult = {
  token: string;
  /** Used to renew `token` without asking for the password again. */
  refreshToken: string | null;
  user: {
    id: string;
    email: string;
    name: string;
  };
};

/** A renewed session. A refresh answers with tokens, not with user data. */
export type RefreshResult = {
  token: string;
  refreshToken: string | null;
};

/**
 * Login, registration and session renewal against the API gateway.
 *
 * Nothing here has a local fallback. A session that only exists on the tablet
 * would be one whose consents can never reach the audit log — the token it
 * carries is not one the gateway would accept — so a backend that cannot be
 * reached is reported as exactly that, not papered over.
 */

/**
 * Whatever the gateway returns, mapped onto `LoginResult`. The backend answers
 * `{ token, refreshToken, user }`; the alternative spellings are tolerated so
 * a change on that side does not become a login outage on this one.
 */
type AuthResponseBody = {
  token?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  refresh_token?: string;
  user?: { id?: string; sub?: string; email?: string; name?: string };
  id?: string;
  email?: string;
  name?: string;
};

function readToken(body: AuthResponseBody): string | undefined {
  return body.token ?? body.accessToken ?? body.idToken;
}

function readRefreshToken(body: AuthResponseBody): string | null {
  return body.refreshToken ?? body.refresh_token ?? null;
}

function normalizeAuthResponse(body: AuthResponseBody, fallbackEmail: string): LoginResult {
  const token = readToken(body);
  if (!token) {
    throw new Error('La respuesta del servidor no incluyó un token de sesión');
  }

  const user = body.user ?? body;
  return {
    token,
    refreshToken: readRefreshToken(body),
    user: {
      id: user.id ?? body.user?.sub ?? fallbackEmail,
      email: user.email ?? fallbackEmail,
      name: user.name ?? '',
    },
  };
}

/** The gateway's `message` when it answered; a plain explanation when it did not. */
function remoteError(result: Extract<ApiResult<unknown>, { status: 'failed' }>): Error {
  if (result.httpStatus === null) {
    return new Error(`No se pudo conectar con el servidor: ${result.message}`);
  }
  return new Error(result.message);
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await postJson<AuthResponseBody>(
    apiConfig.paths.login,
    { email: normalizedEmail, password },
    { label: 'AUTH · LOGIN' }
  );
  if (result.status !== 'sent') throw remoteError(result);

  return normalizeAuthResponse(result.data, normalizedEmail);
}

export async function register(
  email: string,
  password: string,
  name: string
): Promise<LoginResult> {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await postJson<AuthResponseBody>(
    apiConfig.paths.register,
    { email: normalizedEmail, password, name: name.trim() },
    { label: 'AUTH · REGISTER' }
  );
  if (result.status !== 'sent') throw remoteError(result);

  return normalizeAuthResponse(result.data, normalizedEmail);
}

/**
 * Renews the session token. If this fails the session is genuinely over and
 * the caller signs the user out.
 */
export async function refreshSession(refreshToken: string): Promise<RefreshResult> {
  const result = await postJson<AuthResponseBody>(
    apiConfig.paths.refresh,
    { refresh_token: refreshToken },
    { label: 'AUTH · REFRESH' }
  );
  if (result.status !== 'sent') throw remoteError(result);

  const token = readToken(result.data);
  if (!token) {
    throw new Error('La renovación no devolvió un token de sesión');
  }

  return {
    token,
    // Cognito reuses the same refresh token unless rotation is enabled, so a
    // response without one means "keep the one you have".
    refreshToken: readRefreshToken(result.data) ?? refreshToken,
  };
}
