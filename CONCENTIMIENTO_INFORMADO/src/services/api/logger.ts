/**
 * Console tracing for everything the app sends to the API gateway.
 *
 * Each call prints the exact URL, headers and JSON body posted, and the
 * response. Payloads carry base64 signature images and thousands of biometric
 * points, so the printed copy is summarised — the byte count reported is
 * measured on the real body, not on the summary.
 */

/** Strings longer than this are replaced by a length marker in the preview. */
const MAX_STRING_PREVIEW = 120;
/** Arrays longer than this keep a head sample and a "+N more" marker. */
const MAX_ARRAY_PREVIEW = 3;

const REDACTED_KEYS = ['password', 'authorization', 'x-api-key', 'apikey', 'token'];

function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!REDACTED_KEYS.includes(key.toLowerCase())) return value;
  return value.length > 0 ? `<${value.length} chars, redacted>` : '';
}

function summarize(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    const redacted = redactValue(key, value);
    if (redacted !== value) return redacted;
    if (value.length <= MAX_STRING_PREVIEW) return value;
    const head = value.slice(0, 48).replace(/\s+/g, ' ');
    return `${head}… <${value.length} chars total>`;
  }

  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY_PREVIEW) return value.map((item) => summarize(item));
    return [
      ...value.slice(0, MAX_ARRAY_PREVIEW).map((item) => summarize(item)),
      `… +${value.length - MAX_ARRAY_PREVIEW} more`,
    ];
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = summarize(v, k);
    }
    return out;
  }

  return value;
}

function byteLength(body: unknown): number {
  try {
    // Rough but honest: JSON length in UTF-16 code units is what axios will
    // serialise, and for these mostly-ASCII payloads it matches the wire size.
    return JSON.stringify(body)?.length ?? 0;
  } catch {
    return -1;
  }
}

function print(lines: string[]): void {
  // One call, so React Native's log does not interleave the block with
  // whatever else is happening on the bridge.
  console.log(lines.join('\n'));
}

export type OutboundLog = {
  /** Human label for the call, e.g. `AUDIT · CONSENT_SIGNED`. */
  label: string;
  method: string;
  url: string;
  headers?: Record<string, unknown>;
  body?: unknown;
};

export function logOutbound({ label, method, url, headers, body }: OutboundLog): void {
  print([
    `\n┌── → ${label}`,
    `│ ${method.toUpperCase()} ${url}`,
    headers ? `│ headers: ${JSON.stringify(summarize(headers))}` : '│ headers: —',
    `│ body (${byteLength(body)} bytes):`,
    JSON.stringify(summarize(body), null, 2),
    `└── end ${label}\n`,
  ]);
}

export function logInbound(label: string, httpStatus: number, data: unknown, ms: number): void {
  print([
    `┌── ← ${label} · ${httpStatus} · ${ms}ms`,
    JSON.stringify(summarize(data), null, 2),
    `└── end ${label}`,
  ]);
}

export function logFailure(label: string, url: string, detail: string): void {
  print([`┌── ✗ ${label} · FAILED`, `│ POST ${url}`, `│ ${detail}`, `└── end ${label}`]);
}
