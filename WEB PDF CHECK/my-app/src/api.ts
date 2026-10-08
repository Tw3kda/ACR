/**
 * Cliente del API (API GATEWAY/). Sin librerías: fetch + sesión en
 * localStorage.
 *
 * La sesión dura exactamente lo que el token de Cognito (12 h, `exp` del
 * propio token), aunque se cierre la pestaña o el navegador; termina antes
 * con «Cerrar sesión». Se comparte entre pestañas: cerrar sesión en una la
 * cierra en todas. **No se guarda el
 * refresh token**: un token de 30 días en el navegador es lo que un ataque XSS
 * querría robar, y con él se podría renovar la sesión indefinidamente. Al
 * vencer, se vuelve a iniciar sesión. Un 401 cierra la sesión; un 403 se
 * muestra tal cual (falta de permisos, no sesión vencida).
 */

const BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export type User = { id: string | null; email: string | null; name: string | null };
/** `expiresAt`: epoch ms en que Cognito deja de aceptar el token. */
export type Session = { token: string; expiresAt: number; user: User };

const KEY = 'acr.session';
const FALLBACK_TTL_MS = 12 * 3600 * 1000;
const listeners = new Set<(s: Session | null) => void>();

/** `exp` del JWT, en ms. El token lo emitió Cognito; aquí solo se lee la hora. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(payload)).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function isValid(s: unknown): s is Session {
  const c = s as Session | null;
  return Boolean(c && typeof c.token === 'string' && typeof c.expiresAt === 'number' && c.expiresAt > Date.now());
}

export const session = {
  /** La sesión vigente, o null. Una sesión vencida se borra al leerla. */
  get(): Session | null {
    let stored: unknown = null;
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      stored = null;
    }
    if (isValid(stored)) return stored;
    if (stored) {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* nada que borrar */
      }
    }
    return null;
  },
  set(s: Session | null) {
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch {
      /* almacenamiento bloqueado: la sesión dura lo que la página */
    }
    listeners.forEach((fn) => fn(s));
  },
  subscribe(fn: (s: Session | null) => void) {
    listeners.add(fn);
    // Otra pestaña inició o cerró sesión.
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) fn(session.get());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener('storage', onStorage);
    };
  },
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function send(path: string, init: RequestInit = {}, token?: string) {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body?.message ?? `Error ${res.status}`);
  }
  return body;
}

const EXPIRED = 'La sesión expiró, vuelva a iniciar sesión';

async function authed(path: string, init: RequestInit = {}) {
  const current = session.get();
  if (!current) {
    session.set(null);
    throw new ApiError(401, EXPIRED);
  }
  try {
    return await send(path, init, current.token);
  } catch (err) {
    // Token revocado o vencido antes de tiempo: sin refresh, se vuelve a entrar.
    if (err instanceof ApiError && err.status === 401) {
      session.set(null);
      throw new ApiError(401, EXPIRED);
    }
    throw err;
  }
}

export async function login(email: string, password: string) {
  const data = await send('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  // data.refreshToken se ignora a propósito (ver arriba).
  const expiresAt =
    tokenExpiry(data.token) ??
    (Number.isFinite(data.expiresIn) ? Date.now() + data.expiresIn * 1000 : Date.now() + FALLBACK_TTL_MS);
  session.set({ token: data.token, expiresAt, user: data.user });
}

export const logout = () => session.set(null);

// --- Consulta ------------------------------------------------------------------

export type ConsentLog = {
  log_id?: string;
  timestamp_utc?: string;
  subject?: { patient_id?: string; id_type?: string; full_name?: string; medical_exam_type?: string };
  signature_data?: Record<string, unknown>;
  capture_metadata?: { operator_id?: string; clinic_location_id?: string; [k: string]: unknown };
  device_context?: { device_brand?: string; device_model?: string; ip_address?: string; [k: string]: unknown };
  /** El formulario que la tablet dice haber usado. */
  template?: { code?: string; version?: string; title?: string; exam_type?: string };
  /** Lo que el servidor comprobó contra las plantillas publicadas. */
  template_ref?: { code: string | null; version: string | null; verified: boolean; sha256?: string; reason?: string };
  [k: string]: unknown;
};

export type ConsentItem = {
  consent_id: string;
  event_type: string | null;
  timestamp_utc: string | null;
  received_at_utc: string | null;
  log: ConsentLog;
  biometric_strokes: number;
  pdf: { verified: boolean; size_bytes: number | null; sha256: string | null; verified_at_utc: string | null } | null;
  events: { key: string; seq: number; event_type: string; recorded_at_utc: string; prev_hash: string | null; sha256: string }[];
};

export type AccessItem = {
  event_type: string;
  patient_id: string;
  consent_id: string | null;
  timestamp_utc: string;
  operator_id: string | null;
  operator_username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string;
  kind?: string;
};

// POST y no GET: la cédula va en el cuerpo, no en la URL ni en el historial.
export const searchConsents = (patientId: string): Promise<{ items: ConsentItem[] }> =>
  authed('/audit/search', { method: 'POST', body: JSON.stringify({ patient_id: patientId, kind: 'consents' }) });

export const searchAccess = (patientId: string): Promise<{ items: AccessItem[] }> =>
  authed('/audit/search', { method: 'POST', body: JSON.stringify({ patient_id: patientId, kind: 'access' }) });

export type PatientCard = { patient_id: string; full_name: string | null; consents: number; last_at: string | null };

/** Pacientes atendidos hoy, con "hoy" en la zona horaria de este navegador. */
export function listToday(): Promise<{ items: PatientCard[] }> {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return authed('/patients/today', { method: 'POST', body: JSON.stringify({ from: from.toISOString(), to: to.toISOString() }) });
}

/** Pacientes cuya cédula o nombre coincide con lo escrito (mínimo 3 letras o números). */
export const suggestPatients = (q: string): Promise<{ items: PatientCard[] }> =>
  authed('/patients/suggest', { method: 'POST', body: JSON.stringify({ q }) });

export const getPdfUrl =(consentId: string, inline: boolean): Promise<{ url: string; filename: string }> =>
  authed(`/consents/${encodeURIComponent(consentId)}/pdf-download-url${inline ? '?inline=1' : ''}`);
