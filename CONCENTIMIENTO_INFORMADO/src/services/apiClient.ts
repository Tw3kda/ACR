import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { apiConfig, isApiConfigured, resolveUrl } from '@/services/api/config';
import { logFailure, logInbound, logOutbound } from '@/services/api/logger';

/**
 * The single door to the API gateway.
 *
 * `postJson` never throws on a transport problem — callers get a result they
 * can act on — so a backend outage can never take the signing flow down with
 * it. With `EXPO_PUBLIC_API_LOG` on, every request and response is printed.
 *
 * A missing `EXPO_PUBLIC_API_URL` is a configuration error and is reported as
 * a failed request, never simulated: an app that pretends to have sent an
 * audit log is worse than one that says it could not.
 */
export const apiClient = axios.create({
  baseURL: apiConfig.baseUrl ?? undefined,
  timeout: apiConfig.timeoutMs,
  headers: {
    'Content-Type': 'application/json',
    ...(apiConfig.apiKey ? { 'x-api-key': apiConfig.apiKey } : {}),
  },
});

export function setAuthToken(token: string | null) {
  if (token) {
    apiClient.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete apiClient.defaults.headers.common.Authorization;
  }
}

/**
 * Renews an expired session. Registered by the auth store, which owns the
 * refresh token — this module must not import it, or the two would form a
 * cycle. Returns the new token, or null when the session is truly over.
 */
type TokenRefreshHandler = () => Promise<string | null>;

let refreshHandler: TokenRefreshHandler | null = null;

export function setTokenRefreshHandler(handler: TokenRefreshHandler | null) {
  refreshHandler = handler;
}

/**
 * In-flight refresh, shared by every request that got a 401 at once. Without
 * this, a screen firing three calls on resume would trigger three refreshes and
 * — with refresh-token rotation on — invalidate its own session.
 */
let refreshInFlight: Promise<string | null> | null = null;

function refreshOnce(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (refreshHandler ? refreshHandler() : Promise.resolve(null)).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Marks a request that has already been retried, so a loop cannot form. */
type RetriableConfig = InternalAxiosRequestConfig & { __didRetryAfterRefresh?: boolean };

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const isExpired = error.response?.status === 401;

    if (!isExpired || !config || config.__didRetryAfterRefresh || !refreshHandler) {
      return Promise.reject(error);
    }

    const token = await refreshOnce();
    if (!token) return Promise.reject(error);

    config.__didRetryAfterRefresh = true;
    config.headers.set('Authorization', `Bearer ${token}`);
    return apiClient.request(config);
  }
);

export type ApiResult<T> =
  | { status: 'sent'; httpStatus: number; data: T }
  /** `httpStatus` is null when no response arrived (network, config). */
  | { status: 'failed'; httpStatus: number | null; message: string };

function describeError(error: unknown): { httpStatus: number | null; message: string } {
  const axiosError = error as AxiosError<{ message?: string }>;
  if (axiosError?.isAxiosError) {
    const httpStatus = axiosError.response?.status ?? null;
    const body = axiosError.response?.data;
    const fromBody = typeof body === 'string' ? body : body?.message;
    return { httpStatus, message: fromBody ?? axiosError.message };
  }
  return { httpStatus: null, message: error instanceof Error ? error.message : String(error) };
}

/** Headers as they will actually leave, for the trace. */
function outboundHeaders(): Record<string, unknown> {
  const common = apiClient.defaults.headers.common ?? {};
  return {
    'Content-Type': 'application/json',
    ...(apiConfig.apiKey ? { 'x-api-key': apiConfig.apiKey } : {}),
    ...(common.Authorization ? { Authorization: String(common.Authorization) } : {}),
  };
}

export async function postJson<T>(
  path: string,
  body: unknown,
  options: { label: string }
): Promise<ApiResult<T>> {
  const url = resolveUrl(path);

  // Printed before anything else, so the payload shows up whether or not the
  // request goes anywhere.
  if (apiConfig.verbose) {
    logOutbound({ label: options.label, method: 'POST', url, headers: outboundHeaders(), body });
  }

  if (!isApiConfigured()) {
    const message = 'EXPO_PUBLIC_API_URL no está configurada';
    if (apiConfig.verbose) logFailure(options.label, url, message);
    return { status: 'failed', httpStatus: null, message };
  }

  const startedAt = Date.now();
  try {
    const response = await apiClient.post<T>(path, body);
    if (apiConfig.verbose) {
      logInbound(options.label, response.status, response.data, Date.now() - startedAt);
    }
    return { status: 'sent', httpStatus: response.status, data: response.data };
  } catch (error) {
    const { httpStatus, message } = describeError(error);
    if (apiConfig.verbose) {
      logFailure(options.label, url, `${httpStatus ?? 'no response'} · ${message}`);
    }
    return { status: 'failed', httpStatus, message };
  }
}

/** GET counterpart of `postJson`: never throws, same logging. */
export async function getJson<T>(path: string, options: { label: string }): Promise<ApiResult<T>> {
  const url = resolveUrl(path);
  if (apiConfig.verbose) {
    logOutbound({ label: options.label, method: 'GET', url, headers: outboundHeaders(), body: null });
  }
  if (!isApiConfigured()) {
    return { status: 'failed', httpStatus: null, message: 'EXPO_PUBLIC_API_URL no está configurada' };
  }
  const startedAt = Date.now();
  try {
    const response = await apiClient.get<T>(path);
    if (apiConfig.verbose) logInbound(options.label, response.status, response.data, Date.now() - startedAt);
    return { status: 'sent', httpStatus: response.status, data: response.data };
  } catch (error) {
    const { httpStatus, message } = describeError(error);
    if (apiConfig.verbose) logFailure(options.label, url, `${httpStatus ?? 'no response'} · ${message}`);
    return { status: 'failed', httpStatus, message };
  }
}
