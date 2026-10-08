/**
 * Every knob the app needs to talk to the API gateway, read from
 * `EXPO_PUBLIC_*` environment variables in one place.
 *
 * Expo inlines these at bundle time and only when they are written as a
 * literal `process.env.EXPO_PUBLIC_NAME` property access — no destructuring,
 * no `process.env[key]`. That is why every variable is spelled out here
 * instead of being looked up from a list, and why this is the only module
 * that touches `process.env`.
 *
 * Nothing here is a secret: `EXPO_PUBLIC_` values ship in plain text inside
 * the bundle. Endpoints, bucket names and the gateway's public API key are
 * fine; signing credentials are not — those stay behind the gateway.
 */

function text(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function optional(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (trimmed === '') return fallback;
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on';
}

const baseUrl = optional(process.env.EXPO_PUBLIC_API_URL);

export const apiConfig = {
  /** API gateway origin, e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/dev`. */
  baseUrl,
  /** Value for the gateway's `x-api-key` header, when the stage requires one. */
  apiKey: optional(process.env.EXPO_PUBLIC_API_KEY),
  timeoutMs: integer(process.env.EXPO_PUBLIC_API_TIMEOUT_MS, 15000),
  /** Print every outbound payload and every response to the console. */
  verbose: flag(process.env.EXPO_PUBLIC_API_LOG, __DEV__),

  paths: {
    login: text(process.env.EXPO_PUBLIC_AUTH_LOGIN_PATH, '/auth/login'),
    register: text(process.env.EXPO_PUBLIC_AUTH_REGISTER_PATH, '/auth/register'),
    refresh: text(process.env.EXPO_PUBLIC_AUTH_REFRESH_PATH, '/auth/refresh'),
    /** Log + PDF in one request; the backend verifies and stores both. */
    consents: text(process.env.EXPO_PUBLIC_CONSENTS_PATH, '/consents'),
    /** Active consent forms, published to AWS with scripts/publish-template.mjs. */
    templates: text(process.env.EXPO_PUBLIC_TEMPLATES_PATH, '/templates'),
    template: text(process.env.EXPO_PUBLIC_TEMPLATE_PATH, '/templates/{code}'),
  },

  auth: {
    /**
     * How long a session token is assumed to last. The app renews well before
     * this, so the value only has to match what the backend issues — change it
     * here and in Cognito together, nowhere else.
     */
    tokenTtlHours: integer(process.env.EXPO_PUBLIC_AUTH_TOKEN_TTL_HOURS, 12),
    /**
     * How early to renew, as a fraction of the TTL. At 12 h and 0.9 the app
     * refreshes after ~10.8 h, leaving over an hour of margin for a tablet
     * that was asleep when the timer should have fired.
     */
    refreshAtFraction: 0.9,
  },

  /** Values the log needs that only the deployment knows. */
  clinic: {
    locationId: text(process.env.EXPO_PUBLIC_CLINIC_LOCATION_ID, 'SEDE_NO_CONFIGURADA'),
    defaultIdType: text(process.env.EXPO_PUBLIC_DEFAULT_ID_TYPE, 'CC'),
    defaultExamType: text(
      process.env.EXPO_PUBLIC_MEDICAL_EXAM_TYPE,
      'EXAMEN_INGRESO_OCUPACIONAL'
    ),
  },

  /** Where the backend will park the PDF. The app only predicts the key. */
  storage: {
    pdfBucket: text(process.env.EXPO_PUBLIC_PDF_S3_BUCKET, 'medical-consent-pdfs-bucket'),
    pdfPrefix: text(process.env.EXPO_PUBLIC_PDF_S3_PREFIX, 'consents'),
  },
} as const;

/** True once `EXPO_PUBLIC_API_URL` points somewhere. */
export function isApiConfigured(): boolean {
  return apiConfig.baseUrl !== null;
}

/**
 * Fills `{consent_id}`-style placeholders in a configured path. Keeping the
 * placeholder in the environment variable means a backend that routes
 * differently (`/pdf-url?consent=<id>`, say) needs a config change, not a code
 * change.
 */
export function resolvePath(path: string, params: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? encodeURIComponent(params[key]) : match
  );
}

/** Absolute URL for a configured path — for logging, mostly. */
export function resolveUrl(path: string): string {
  if (!apiConfig.baseUrl) return path;
  return `${apiConfig.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
