/**
 * Traza de entrada/salida para el modo simulado.
 *
 * Mientras no haya conexión con Cognito, DynamoDB y S3, lo único que se puede
 * comprobar es *qué llega* y *qué se responde*. Esto lo imprime en consola en
 * bloques legibles —no en JSON de una línea como el logger— para poder
 * contrastarlo con el payload que la app muestra en el log de Metro.
 *
 * Se activa solo cuando algún adaptador está simulado, o a mano con TRACE_IO.
 * En producción con AWS real queda apagado: el logger estructurado es el que
 * sirve en CloudWatch, y volcar cuerpos completos ahí es un problema de
 * privacidad, no una ayuda.
 */
import config from '../config/env.js';

const { enabled, maxChars, redact: shouldRedact, full, colors } = config.trace;

export const traceEnabled = enabled;

const C = colors
  ? {
      dim: (s) => `[2m${s}[0m`,
      cyan: (s) => `[36m${s}[0m`,
      green: (s) => `[32m${s}[0m`,
      yellow: (s) => `[33m${s}[0m`,
      red: (s) => `[31m${s}[0m`,
      magenta: (s) => `[35m${s}[0m`,
    }
  : {
      dim: (s) => s,
      cyan: (s) => s,
      green: (s) => s,
      yellow: (s) => s,
      red: (s) => s,
      magenta: (s) => s,
    };

const SENSITIVE = new Set([
  'password',
  'newpassword',
  'secret',
  'clientsecret',
  'secrethash',
  'authorization',
  'x-api-key',
]);

// Se muestran acortados —no ocultos—: sirven para seguir el flujo, y un token
// completo en consola acaba pegado en un ticket.
const SHORTENED = new Set([
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'refresh_token',
  'url',
]);

const shorten = (value) => {
  if (typeof value !== 'string' || value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-6)} (${value.length} car.)`;
};

/**
 * La biometría es el 90 % del ítem: una firma de 5 s son miles de puntos que
 * llenan la pantalla sin aportar nada. Se resumen salvo que TRACE_FULL=true.
 */
function prepare(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[…]';

  if (Array.isArray(value)) {
    if (!full && value.length > 5) {
      return [...value.slice(0, 3).map((v) => prepare(v, depth + 1)), `… +${value.length - 3} elemento(s)`];
    }
    return value.map((v) => prepare(v, depth + 1));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const k = key.toLowerCase();
    if (shouldRedact && SENSITIVE.has(k)) out[key] = '«oculto»';
    else if (shouldRedact && SHORTENED.has(k)) out[key] = shorten(val);
    else out[key] = prepare(val, depth + 1);
  }
  return out;
}

function render(value) {
  if (value === undefined) return C.dim('(sin cuerpo)');
  let text;
  try {
    text = JSON.stringify(prepare(value), null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) return C.dim('(sin cuerpo)');
  if (!full && text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n${C.dim(`… recortado, ${text.length - maxChars} caracteres más (TRACE_FULL=true para verlo entero)`)}`;
  }
  return text;
}

const line = (char = '─') => C.dim(char.repeat(72));

export function traceRequest({ requestId, method, path, headers, body, sourceIp }) {
  if (!enabled) return;
  const id = C.dim(`#${String(requestId).slice(0, 8)}`);
  process.stdout.write(
    [
      '',
      line(),
      `${C.cyan('▶ RECIBIDO')}  ${C.yellow(method)} ${path}  ${id}  ${C.dim(`ip ${sourceIp ?? '?'}`)}`,
      C.dim('cabeceras:'),
      render(headers),
      C.dim('cuerpo:'),
      render(body),
      '',
    ].join('\n'),
  );
}

export function traceResponse({ requestId, method, path, status, body, durationMs }) {
  if (!enabled) return;
  const id = C.dim(`#${String(requestId).slice(0, 8)}`);
  const paint = status >= 500 ? C.red : status >= 400 ? C.yellow : C.green;
  process.stdout.write(
    [
      `${paint('◀ ENVIADO ')}  ${paint(String(status))} ${C.yellow(method)} ${path}  ${id}  ${C.dim(`${durationMs} ms`)}`,
      C.dim('cuerpo:'),
      render(body),
      line(),
      '',
    ].join('\n'),
  );
}

/**
 * Lo que se *habría* enviado al servicio de AWS. Es la mitad que falta: sin
 * esto se ve la conversación con la app pero no la llamada que quedará
 * pendiente de implementar.
 */
export function traceAws({ service, operation, input, output, note }) {
  if (!enabled) return;
  process.stdout.write(
    [
      `${C.magenta('☁ AWS (simulado)')} ${service}.${operation}${note ? C.dim(`  — ${note}`) : ''}`,
      C.dim('  entrada:'),
      render(input),
      ...(output === undefined ? [] : [C.dim('  salida:'), render(output)]),
      '',
    ].join('\n'),
  );
}

export default { traceEnabled, traceRequest, traceResponse, traceAws };
