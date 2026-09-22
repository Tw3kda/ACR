import config from '../config/env.js';

const LEVELS = { error: 50, warn: 40, info: 30, debug: 20 };

/**
 * Nada de esto puede acabar en CloudWatch: son credenciales, tokens de sesión
 * o el propio dato biométrico del paciente. La redacción es por nombre de campo
 * y se aplica recursivamente antes de serializar.
 */
const REDACTED_KEYS = new Set([
  'password',
  'newpassword',
  'previouspassword',
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'x-api-key',
  'apikey',
  'secret',
  'secrethash',
  'clientsecret',
  'biometrics_json',
  'strokes',
  'points',
  'url',
  'signedurl',
]);

const MAX_DEPTH = 6;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) {
    return value.length > 20
      ? [`[array de ${value.length}]`]
      : value.map((v) => redact(v, depth + 1));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redactado]' : redact(val, depth + 1);
  }
  return out;
}

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    time: new Date().toISOString(),
    service: config.serviceName,
    message,
    ...redact(fields),
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export const logger = {
  error: (message, fields) => emit('error', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  info: (message, fields) => emit('info', message, fields),
  debug: (message, fields) => emit('debug', message, fields),
  /** Logger con campos fijos (request_id, ruta, etc.). */
  child(base) {
    return {
      error: (m, f) => emit('error', m, { ...base, ...f }),
      warn: (m, f) => emit('warn', m, { ...base, ...f }),
      info: (m, f) => emit('info', m, { ...base, ...f }),
      debug: (m, f) => emit('debug', m, { ...base, ...f }),
      child: (extra) => logger.child({ ...base, ...extra }),
    };
  },
};

export default logger;
