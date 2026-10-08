import config from '../config/env.js';
import { evidence, s3 } from '../aws/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isSafeId } from '../lib/validate.js';
import logger from '../lib/logger.js';
import { nameSlug } from '../lib/nameKey.js';
import { writePointers } from './auditService.js';

/**
 * Web de consulta: buscar por cédula, ver el rastro de auditoría de cada
 * consentimiento y entregar el PDF por URL firmada. Solo lee — lo único que
 * escribe es el registro de acceso, y solo cuando se entrega un PDF (vista
 * previa o descarga). Buscar, listar o abrir una ficha no se registra: es
 * decisión de la clínica (2026-10). Ese registro se escribe ANTES de entregar
 * la URL: un PDF entregado sin rastro no debe ocurrir.
 */

// Cédula y demás documentos (CE, TI, PA): alfanumérico, 4–20. Acota la clave
// de S3 que se construye con ella.
const PATIENT_ID = /^[A-Za-z0-9]{4,20}$/;
const KINDS = new Set(['consents', 'access']);

/** `2026-09-12T06:04:55.448Z` → `2026-09-12T06-04-55.448Z`: ordenable y válido en una clave. */
const stampForKey = (iso) => iso.replace(/:/g, '-');

function operatorFrom(ctx) {
  const c = ctx.claims ?? {};
  return {
    operator_id: ctx.operatorId ?? null,
    operator_username: c.email ?? c.username ?? c['cognito:username'] ?? null,
    operator_groups: ctx.groups ?? [],
  };
}

export async function recordAccess({ patientId, eventType, consentId = null, ctx, extra = {} }) {
  const at = new Date().toISOString();
  const record = {
    event_type: eventType,
    patient_id: patientId,
    consent_id: consentId,
    timestamp_utc: at,
    ...operatorFrom(ctx),
    ip_address: ctx.sourceIp ?? null,
    user_agent: ctx.userAgent ?? null,
    request_id: ctx.requestId,
    ...extra,
  };
  await evidence.putAccessRecord({
    patientId,
    name: `${stampForKey(at)}_${String(ctx.requestId).slice(0, 8)}`,
    record,
  });
  return record;
}

/** Los consent_id de un paciente según el índice, del más reciente al más antiguo. */
async function consentIdsForPatient(patientId, max) {
  const prefix = `patient/${patientId}/`;
  const keys = [];
  let token;
  do {
    const page = await evidence.listPointers(prefix, { limit: 1000, continuationToken: token });
    keys.push(...page.keys);
    token = page.nextToken;
  } while (token);

  // patient/<cc>/<fecha>_<consent_id>; la fecha no lleva "_".
  const ids = keys.map((k) => k.slice(prefix.length).split('_').slice(1).join('_')).filter(Boolean);
  return [...new Set(ids)].reverse().slice(0, max);
}

/** Un consentimiento como lo muestra la web: el log (sin biometría), su verificación y la cadena de eventos. */
function summarize(consentId, events) {
  const first = events[0];
  const verified = events.find((e) => e.event.event_type === 'PDF_VERIFIED');
  const { biometrics_json: biometrics, ...log } = first?.event.payload ?? {};

  return {
    consent_id: consentId,
    event_type: first?.event.event_type ?? null,
    timestamp_utc: log.timestamp_utc ?? null,
    received_at_utc: log.received_at_utc ?? null,
    log,
    biometric_strokes: Array.isArray(biometrics?.strokes) ? biometrics.strokes.length : 0,
    pdf: verified
      ? {
          verified: verified.event.payload?.verified === true,
          size_bytes: verified.event.payload?.size_bytes ?? null,
          sha256: verified.event.payload?.checksum_sha256 ?? null,
          verified_at_utc: verified.event.recorded_at_utc ?? null,
        }
      : null,
    events: events.map((e) => ({
      key: e.key,
      seq: e.event.seq,
      event_type: e.event.event_type,
      recorded_at_utc: e.event.recorded_at_utc,
      prev_hash: e.event.prev_hash ?? null,
      sha256: e.sha256,
    })),
  };
}

export async function searchByPatient({ patientId, kind = 'consents', ctx }) {
  const id = String(patientId ?? '').trim();
  if (!PATIENT_ID.test(id)) {
    throw badRequest('Escriba un número de documento válido (solo letras y números, de 4 a 20)', {
      details: { field: 'patient_id' },
    });
  }
  if (!KINDS.has(kind)) throw badRequest('El campo "kind" debe ser "consents" o "access"');

  const max = config.audit.searchMaxItems;
  let items;
  if (kind === 'access') {
    items = (await evidence.listAccessRecords(id, { limit: max })).reverse();
  } else {
    const ids = await consentIdsForPatient(id, max);
    items = await Promise.all(ids.map(async (cid) => summarize(cid, await evidence.listEvents(cid))));
  }

  logger.info('consulta por paciente', {
    operator_id: ctx.operatorId,
    kind,
    count: items.length,
    request_id: ctx.requestId,
  });

  return { patient_id: id, kind, items };
}

/** `fn` sobre cada elemento, como mucho `limit` a la vez: cientos de GET a S3 sin saturar la Lambda. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const MAX_RANGE_MS = 48 * 3600 * 1000;

/**
 * Pacientes atendidos en [from, to) — el "hoy" lo decide el navegador en su
 * zona horaria. El índice por fecha va en días UTC, así que se leen todos los
 * días UTC que toca el rango y se filtra por la hora exacta de la firma.
 */
export async function listPatientsBetween({ from, to, ctx }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end - start > MAX_RANGE_MS) {
    throw badRequest('Rango de fechas inválido (máximo 48 horas)', { details: { from, to } });
  }

  const days = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d < end; d = new Date(d.getTime() + 86400000)) {
    days.push(d.toISOString().slice(0, 10).replace(/-/g, '/'));
  }

  const ids = [];
  for (const day of days) {
    let token;
    do {
      const page = await evidence.listPointers(`date/${day}/`, { limit: 1000, continuationToken: token });
      ids.push(...page.keys.map((k) => k.split('/').pop()));
      token = page.nextToken;
    } while (token);
  }

  const events = await mapLimit([...new Set(ids)], 25, (cid) => evidence.listEvents(cid));

  const patients = new Map();
  for (const evs of events) {
    const payload = evs[0]?.event.payload;
    const at = payload?.timestamp_utc;
    const id = payload?.subject?.patient_id;
    if (!id || !at || new Date(at) < start || new Date(at) >= end) continue;
    const p = patients.get(id) ?? { patient_id: id, full_name: null, consents: 0, last_at: at };
    p.consents += 1;
    if (at >= p.last_at) {
      p.last_at = at;
      p.full_name = payload.subject.full_name ?? p.full_name;
    }
    p.full_name ??= payload.subject.full_name ?? null;
    patients.set(id, p);
  }

  const items = [...patients.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  logger.info('pacientes del día', { operator_id: ctx.operatorId, count: items.length, request_id: ctx.requestId });
  return { items };
}

// Las cédulas y los nombres del índice se cachean en el contenedor: la
// búsqueda mientras se escribe los pide varias veces seguidas.
const INDEX_TTL_MS = 30_000;
let patientIdsCache = { at: 0, ids: [] };
let namesCache = { at: 0, entries: [] };

async function allPatientIds() {
  if (Date.now() - patientIdsCache.at > INDEX_TTL_MS) {
    patientIdsCache = { at: Date.now(), ids: await evidence.listPatientIds() };
  }
  return patientIdsCache.ids;
}

/** `[{ id, slug }]` desde `index/name/<cédula>/<nombre>`: solo se listan claves, no se lee ningún objeto. */
async function allNames() {
  if (Date.now() - namesCache.at > INDEX_TTL_MS) {
    const entries = [];
    let token;
    do {
      const page = await evidence.listPointers('name/', { limit: 1000, continuationToken: token });
      for (const k of page.keys) {
        const [, id, slug] = k.split('/');
        if (id && slug) entries.push({ id, slug });
      }
      token = page.nextToken;
    } while (token);
    namesCache = { at: Date.now(), entries };
  }
  return namesCache.entries;
}

// Lo que se puede escribir: documento (letras y números) o nombre (letras con
// tilde, espacios, punto, apóstrofo, guion).
const SUGGEST_QUERY = /^[\p{L}0-9 .'-]{3,60}$/u;

/**
 * Búsqueda mientras se escribe, por documento o por nombre:
 * - cédulas que CONTIENEN lo escrito (primero las que empiezan por ello);
 * - nombres que contienen cada palabra escrita, en cualquier orden, sin
 *   importar tildes ni mayúsculas ("pena mar" encuentra "María Peña").
 * Primero las coincidencias por documento, luego por nombre; con el nombre y
 * la fecha del último consentimiento de cada paciente.
 */
export async function suggestPatients({ q, ctx }) {
  const query = String(q ?? '').trim().replace(/\s+/g, ' ');
  const words = nameSlug(query).split('-').filter(Boolean);
  if (!SUGGEST_QUERY.test(query) || (!/^[A-Za-z0-9]+$/.test(query) && words.join('').length < 3)) {
    throw badRequest('Escriba al menos 3 caracteres del documento o del nombre', { details: { field: 'q' } });
  }

  const byId = [];
  if (/^[A-Za-z0-9]+$/.test(query)) {
    const lower = query.toLowerCase();
    byId.push(
      ...(await allPatientIds())
        .filter((id) => id.toLowerCase().includes(lower))
        .sort((a, b) => Number(!a.toLowerCase().startsWith(lower)) - Number(!b.toLowerCase().startsWith(lower)) || a.localeCompare(b)),
    );
  }

  const byName = [];
  if (words.length) {
    const starts = (slug) => slug.startsWith(words[0]);
    byName.push(
      ...(await allNames())
        .filter((n) => words.every((w) => n.slug.includes(w)))
        .sort((a, b) => Number(!starts(a.slug)) - Number(!starts(b.slug)) || a.slug.localeCompare(b.slug))
        .map((n) => n.id),
    );
  }

  const nameMatches = new Set(byName);
  const matches = [...new Set([...byId, ...byName])].slice(0, 12);

  const items = await mapLimit(matches, 12, async (id) => {
    const prefix = `patient/${id}/`;
    const { keys } = await evidence.listPointers(prefix, { limit: 1000 });
    const last = keys.sort().at(-1);
    const consentId = last?.slice(prefix.length).split('_').slice(1).join('_');
    const first = consentId ? (await evidence.listEvents(consentId))[0]?.event.payload : null;
    return {
      patient_id: id,
      full_name: first?.subject?.full_name ?? null,
      consents: keys.length,
      last_at: first?.timestamp_utc ?? null,
      matched_by: nameMatches.has(id) && !byId.includes(id) ? 'name' : 'id',
    };
  });

  logger.info('sugerencias de pacientes', { operator_id: ctx.operatorId, count: items.length, request_id: ctx.requestId });
  return { query, items };
}

/**
 * Administración: escribe `index/name/` para los consentimientos guardados
 * antes de que existiera. Idempotente (un puntero repetido no se reescribe),
 * así que se puede repetir sin riesgo.
 */
export async function reindexNames() {
  const ids = await evidence.listPatientIds();
  const consentIds = [];
  for (const id of ids) {
    const prefix = `patient/${id}/`;
    let token;
    do {
      const page = await evidence.listPointers(prefix, { limit: 1000, continuationToken: token });
      consentIds.push(...page.keys.map((k) => k.slice(prefix.length).split('_').slice(1).join('_')).filter(Boolean));
      token = page.nextToken;
    } while (token);
  }

  let written = 0;
  await mapLimit(consentIds, 20, async (cid) => {
    const payload = (await evidence.listEvents(cid))[0]?.event.payload;
    if (!payload?.subject?.patient_id || !payload.timestamp_utc) return;
    await writePointers(payload, cid);
    written += 1;
  });
  namesCache = { at: 0, entries: [] };
  return { patients: ids.length, consents: consentIds.length, reindexed: written };
}

/**
 * URL firmada de lectura del PDF. Solo si existe el evento PDF_VERIFIED: un
 * documento cuyo checksum no se comprobó no debe circular como si fuera el
 * consentimiento.
 */
export async function issuePdfDownloadUrl({ consentId, inline = false, ctx }) {
  if (!isSafeId(consentId)) throw badRequest('Identificador de consentimiento inválido');

  const events = await evidence.listEvents(consentId);
  const signed = events.find((e) => e.event.event_type === 'CONSENT_SIGNED' || e.event.event_type === 'CONSENT_DECLINED');
  if (!signed) throw notFound('No existe un consentimiento firmado con ese identificador');

  const verified = events.find((e) => e.event.event_type === 'PDF_VERIFIED')?.event.payload;
  if (verified?.verified !== true || !verified.key) {
    throw conflict('El PDF de este consentimiento no ha sido verificado');
  }

  const patientId = signed.event.payload?.subject?.patient_id;
  const signedUrl = await s3.presignPdfGet({
    bucket: verified.bucket,
    key: verified.key,
    filename: `${consentId}.pdf`,
    inline,
  });

  await recordAccess({
    patientId,
    eventType: inline ? 'PDF_VIEWED' : 'PDF_DOWNLOADED',
    consentId,
    ctx,
    extra: {
      pdf_key: verified.key,
      pdf_sha256: verified.checksum_sha256 ?? null,
      url_expires_in: signedUrl.expiresIn,
    },
  });

  logger.info('URL de PDF firmada', {
    consent_id: consentId,
    operator_id: ctx.operatorId,
    inline,
    expires_in: signedUrl.expiresIn,
    request_id: ctx.requestId,
  });

  return {
    url: signedUrl.url,
    expires_in: signedUrl.expiresIn,
    filename: signedUrl.filename,
    pdf_sha256: verified.checksum_sha256 ?? null,
    pdf_size_bytes: verified.size_bytes ?? null,
  };
}
