/**
 * Punto único de configuración. Todo lo que toca AWS sale de aquí y de nada más:
 * mientras la infraestructura no exista, cada adaptador arranca en modo `stub` y
 * el API responde igual, así que la app se puede integrar hoy y solo hay que
 * rellenar el .env cuando los recursos estén creados.
 */

const raw = process.env;

const str = (value, fallback = '') => {
  const v = value === undefined || value === null ? '' : String(value).trim();
  return v === '' ? fallback : v;
};

const bool = (value, fallback = false) => {
  const v = str(value);
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v.toLowerCase());
};

const int = (value, fallback) => {
  const n = Number.parseInt(str(value), 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value, fallback = []) => {
  const v = str(value);
  if (v === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

const nodeEnv = str(raw.NODE_ENV, 'development');
const isProduction = nodeEnv === 'production';

// --- Cognito -----------------------------------------------------------------
const cognitoUserPoolId = str(raw.COGNITO_USER_POOL_ID);
const cognitoClientId = str(raw.COGNITO_CLIENT_ID);
const cognitoClientSecret = str(raw.COGNITO_CLIENT_SECRET);
const cognitoReady = Boolean(cognitoUserPoolId && cognitoClientId);

// --- S3: PDFs ------------------------------------------------------------------
const pdfBucket = str(raw.PDF_BUCKET);
const s3Ready = Boolean(pdfBucket);

// --- S3: evidencia (eventos de auditoría + índice) ------------------------------
const evidenceBucket = str(raw.EVIDENCE_BUCKET);
const evidenceReady = Boolean(evidenceBucket);

// Los tres drivers se resuelven aquí porque hay más de una decisión que depende
// de ellos (la traza de consola, entre otras).
const cognitoDriver = str(raw.COGNITO_DRIVER, cognitoReady ? 'aws' : 'stub');
const evidenceDriver = str(raw.EVIDENCE_DRIVER, evidenceReady ? 'aws' : 'stub');
const s3Driver = str(raw.S3_DRIVER, s3Ready ? 'aws' : 'stub');
const stubsResolved = [cognitoDriver, evidenceDriver, s3Driver];

const config = {
  nodeEnv,
  isProduction,
  logLevel: str(raw.LOG_LEVEL, isProduction ? 'info' : 'debug'),
  serviceName: str(raw.SERVICE_NAME, 'acr-consent-api'),

  http: {
    port: int(raw.PORT, 3000),
    // Con stage `$default` el rawPath ya viene limpio; con stage nombrado llega
    // como `/prod/auth/login` y hay que recortarlo antes de enrutar.
    stagePrefix: str(raw.API_STAGE_PREFIX),
    jsonBodyLimit: str(raw.JSON_BODY_LIMIT, '6mb'),
    // El x-api-key real lo valida API Gateway (plan de uso). Esto es solo una
    // segunda barrera opcional; ver nota de seguridad en la documentación.
    apiKey: str(raw.API_KEY),
    apiKeyEnforced: bool(raw.API_KEY_ENFORCED, false),
    trustProxy: bool(raw.TRUST_PROXY, true),
  },

  cors: {
    enabled: bool(raw.CORS_ENABLED, true),
    origins: list(raw.CORS_ALLOWED_ORIGINS, ['http://localhost:8081']),
    headers: list(raw.CORS_ALLOWED_HEADERS, ['content-type', 'authorization', 'x-api-key']),
    methods: list(raw.CORS_ALLOWED_METHODS, ['GET', 'POST', 'PUT', 'OPTIONS']),
    maxAgeSeconds: int(raw.CORS_MAX_AGE_SECONDS, 600),
  },

  routes: {
    login: str(raw.PATH_AUTH_LOGIN, '/auth/login'),
    register: str(raw.PATH_AUTH_REGISTER, '/auth/register'),
    refresh: str(raw.PATH_AUTH_REFRESH, '/auth/refresh'),
    auditLogs: str(raw.PATH_AUDIT_LOGS, '/audit/logs'),
    consents: str(raw.PATH_CONSENTS, '/consents'),
    health: str(raw.PATH_HEALTH, '/health'),
  },

  // `/health` es una ruta pública en el gateway. Qué adaptadores hay detrás y en
  // qué entorno corre el servicio es información útil para depurar y también
  // para quien busque por dónde entrar: solo se publica fuera de producción.
  health: {
    detailed: bool(raw.HEALTH_DETAILED, !isProduction),
  },

  auth: {
    // `gateway` -> se confía en el JWT authorizer de API Gateway (producción).
    // `local`   -> se decodifica el Bearer sin verificar la firma (solo desarrollo).
    claimsSource: str(raw.AUTH_CLAIMS_SOURCE, 'gateway'),
    allowLocalClaims: bool(raw.AUTH_ALLOW_LOCAL_CLAIMS, !isProduction),
  },

  cognito: {
    driver: cognitoDriver,
    region: str(raw.COGNITO_REGION, str(raw.AWS_REGION, 'us-east-1')),
    endpoint: str(raw.COGNITO_ENDPOINT) || undefined,
    userPoolId: cognitoUserPoolId,
    clientId: cognitoClientId,
    clientSecret: cognitoClientSecret,
    authFlow: str(raw.COGNITO_AUTH_FLOW, 'ADMIN_USER_PASSWORD_AUTH'),
    // Debe coincidir con lo que valide el JWT authorizer del gateway.
    tokenForApp: str(raw.COGNITO_TOKEN_FOR_APP, 'access'), // access | id
    // Con secreto de cliente, REFRESH_TOKEN_AUTH exige SECRET_HASH, y el SECRET_HASH
    // exige el username — que la app no envía. Ver "Hallazgo 2" en la documentación.
    refreshUsernameMode: str(
      raw.COGNITO_REFRESH_USERNAME_MODE,
      cognitoClientSecret ? 'envelope' : 'none',
    ), // envelope | body | none
    registrationEnabled: bool(raw.REGISTRATION_ENABLED, false),
    registrationInviteCode: str(raw.REGISTRATION_INVITE_CODE),
    minPasswordLength: int(raw.MIN_PASSWORD_LENGTH, 8),
  },

  // El registro de auditoría: objetos inmutables en S3 (ver aws/evidence.aws.js).
  evidence: {
    driver: evidenceDriver,
    region: str(raw.EVIDENCE_REGION, str(raw.S3_REGION, str(raw.AWS_REGION, 'us-east-1'))),
    endpoint: str(raw.EVIDENCE_ENDPOINT, str(raw.S3_ENDPOINT)) || undefined,
    forcePathStyle: bool(raw.S3_FORCE_PATH_STYLE, false),
    bucket: evidenceBucket,
    eventsPrefix: str(raw.EVIDENCE_EVENTS_PREFIX, 'events'),
    indexPrefix: str(raw.EVIDENCE_INDEX_PREFIX, 'index'),
  },

  audit: {
    allowedEventTypes: list(raw.AUDIT_ALLOWED_EVENT_TYPES, [
      'CONSENT_SIGNED',
      'CONSENT_VIEWED',
      'CONSENT_DECLINED',
      'CONSENT_REVOKED',
    ]),
    maxBiometricPoints: int(raw.AUDIT_MAX_BIOMETRIC_POINTS, 20000),
  },

  s3: {
    driver: s3Driver,
    region: str(raw.S3_REGION, str(raw.AWS_REGION, 'us-east-1')),
    endpoint: str(raw.S3_ENDPOINT) || undefined,
    forcePathStyle: bool(raw.S3_FORCE_PATH_STYLE, false),
    bucket: pdfBucket,
    keyPrefix: str(raw.PDF_KEY_PREFIX, 'consents'),
    // El PDF viaja en base64 dentro del JSON: 4 MB de PDF son ~5.4 MB de cuerpo,
    // justo bajo los 6 MB que Lambda acepta en una invocación síncrona. Un
    // consentimiento de una página son ~150 KB.
    maxBytes: int(raw.PDF_MAX_BYTES, 4 * 1024 * 1024),
    minBytes: int(raw.PDF_MIN_BYTES, 1024),
    kmsKeyId: str(raw.PDF_SSE_KMS_KEY_ID) || undefined,
  },

  // Traza legible de lo recibido y lo enviado. Se enciende sola mientras algún
  // adaptador esté simulado: es la única forma de ver el flujo sin AWS detrás.
  trace: {
    enabled: bool(raw.TRACE_IO, !stubsResolved.every((d) => d === 'aws')),
    maxChars: int(raw.TRACE_BODY_MAX_CHARS, 4000),
    redact: bool(raw.TRACE_REDACT, true),
    full: bool(raw.TRACE_FULL, false),
    colors: bool(raw.TRACE_COLORS, Boolean(process.stdout?.isTTY) && !raw.AWS_LAMBDA_FUNCTION_NAME),
  },

  stub: {
    allowInProduction: bool(raw.ALLOW_STUB_IN_PRODUCTION, false),
    seedEmail: str(raw.STUB_SEED_EMAIL, 'demo@acrvitallaboral.com'),
    seedPassword: str(raw.STUB_SEED_PASSWORD, 'Demo1234!'),
    seedName: str(raw.STUB_SEED_NAME, 'Usuario Demo'),
  },
};

/** Adaptadores que todavía no apuntan a AWS real. */
export function stubbedDrivers() {
  return Object.entries({
    cognito: config.cognito.driver,
    evidence: config.evidence.driver,
    s3: config.s3.driver,
  })
    .filter(([, driver]) => driver !== 'aws')
    .map(([name]) => name);
}

/**
 * Falla en frío —no en la primera petición— si alguien despliega a producción
 * con adaptadores simulados. Un API de auditoría que responde 201 sin escribir
 * nada es peor que un API caído.
 */
export function assertDeployable() {
  const stubs = stubbedDrivers();
  if (!config.isProduction || stubs.length === 0 || config.stub.allowInProduction) return;
  throw new Error(
    `NODE_ENV=production con adaptadores simulados: ${stubs.join(', ')}. ` +
      'Defina las variables de entorno del recurso, o ALLOW_STUB_IN_PRODUCTION=true de forma explícita.',
  );
}

export default config;
