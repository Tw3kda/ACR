import config from '../config/env.js';
import { evidence } from '../aws/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isSafeId } from '../lib/validate.js';
import { parseTemplate } from '../lib/templateSchema.js';
import logger from '../lib/logger.js';

/**
 * Plantillas de consentimiento, servidas a las tablets desde el bucket de
 * evidencia. El bucket es de escritura única (Object Lock + If-None-Match), así
 * que nada se edita:
 *
 *   templates/<code>/<version>.json        la plantilla, inmutable
 *   templates/_catalog/<00000001>.json      foto del catálogo activo tras cada
 *                                           cambio, numerada; la más alta manda
 *
 * Publicar o retirar = escribir una foto nueva. El historial completo de qué
 * formulario estuvo activo, cuándo y quién lo cambió queda en las fotos.
 */

const PREFIX = config.evidence.templatesPrefix;
const CATALOG = `${PREFIX}/_catalog/`;
const CACHE_TTL_MS = 60_000;

const templateKey = (code, version) => `${PREFIX}/${code}/${version}.json`;

let cache = { at: 0, catalog: null };

/** La foto más reciente del catálogo. Sin ninguna: catálogo vacío. */
async function currentCatalog({ fresh = false } = {}) {
  if (!fresh && cache.catalog && Date.now() - cache.at < CACHE_TTL_MS) return cache.catalog;
  const keys = await evidence.listKeys(CATALOG);
  const latest = keys.at(-1);
  const catalog = latest ? ((await evidence.getJson(latest))?.value ?? { active: [] }) : { active: [] };
  cache = { at: Date.now(), catalog };
  return catalog;
}

/** Lo que la tablet muestra para elegir formulario. */
export async function listActiveTemplates() {
  const catalog = await currentCatalog();
  return {
    updated_at_utc: catalog.at_utc ?? null,
    templates: [...(catalog.active ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

/** Una plantilla completa. Sin versión: la activa. Una retirada sigue disponible pidiendo su versión. */
export async function getTemplate(code, version) {
  if (!isSafeId(code) || (version !== undefined && !isSafeId(version))) {
    throw badRequest('Código o versión de consentimiento inválidos');
  }
  let v = version;
  if (!v) {
    v = (await currentCatalog()).active?.find((t) => t.code === code)?.version;
    if (!v) throw notFound('No hay una versión activa de ese consentimiento');
  }
  const stored = await evidence.getJson(templateKey(code, v));
  if (!stored) throw notFound('No existe esa versión del consentimiento');
  return { template: stored.value, sha256: stored.sha256 };
}

/**
 * Escribe la foto siguiente a `current`. El número va en la clave y la clave
 * es de escritura única: si dos cambios simultáneos parten de la misma foto,
 * el segundo choca (412) en vez de pisar al primero sin que nadie lo note.
 */
async function writeCatalog(current, active, change, actor) {
  const seq = (current.seq ?? 0) + 1;
  const key = `${CATALOG}${String(seq).padStart(8, '0')}.json`;
  const catalog = { schema: 'acr.consent.catalog/1', seq, at_utc: new Date().toISOString(), by: actor, change, active };
  const put = await evidence.putJsonOnce(key, catalog);
  if (!put.created) {
    cache = { at: 0, catalog: null };
    throw conflict('Otro cambio del catálogo ocurrió al mismo tiempo. Vuelva a intentarlo.', { code: 'catalog_race' });
  }
  cache = { at: Date.now(), catalog };
  return { key, catalog };
}

/**
 * Publica una versión. Si ya existe con el MISMO contenido no pasa nada (se
 * puede reintentar); con otro contenido es un error: una versión publicada no
 * se cambia, se sube la versión.
 */
export async function publishTemplate({ raw, activate = true, actor }) {
  const template = parseTemplate(raw);
  const key = templateKey(template.code, template.version);

  const put = await evidence.putJsonOnce(key, template);
  let sha256 = put.sha256;
  if (!put.created) {
    // Comparación canónica: el objeto guardado tiene las claves ordenadas.
    const same = evidence.canonicalJson(put.existing?.value ?? null) === evidence.canonicalJson(template);
    if (!same) {
      throw conflict(
        `La versión ${template.version} de ${template.code} ya está publicada con otro contenido. Suba el número de versión.`,
        { code: 'template_version_exists' },
      );
    }
    sha256 = put.existing.sha256;
  }

  let catalog = null;
  if (activate) {
    const entry = {
      code: template.code,
      version: template.version,
      title: template.title,
      examType: template.examType,
      effectiveDate: template.effectiveDate,
      sha256,
    };
    const current = await currentCatalog({ fresh: true });
    const already = current.active?.find((t) => t.code === template.code);
    if (already?.version === template.version && already.sha256 === sha256) {
      catalog = current; // ya estaba activa: nada que cambiar
    } else {
      const active = [...(current.active ?? []).filter((t) => t.code !== template.code), entry];
      const change = { action: 'publish', code: template.code, version: template.version };
      catalog = (await writeCatalog(current, active, change, actor)).catalog;
    }
  }

  logger.info('plantilla publicada', { code: template.code, version: template.version, activate, sha256, actor });
  return { key, sha256, created: put.created, active: catalog?.active ?? null };
}

/** Deja de ofrecerse en las tablets. Sus versiones siguen guardadas y consultables. */
export async function retireTemplate({ code, actor }) {
  const current = await currentCatalog({ fresh: true });
  const entry = current.active?.find((t) => t.code === code);
  if (!entry) throw notFound(`${code} no está activo`);
  const active = current.active.filter((t) => t.code !== code);
  const { catalog } = await writeCatalog(current, active, { action: 'retire', code, version: entry.version }, actor);
  logger.info('plantilla retirada', { code, version: entry.version, actor });
  return { active: catalog.active };
}

/**
 * Qué plantilla firmó el paciente, comprobado contra lo publicado. Nunca
 * rechaza: un consentimiento firmado no se pierde porque su plantilla no
 * esté publicada (p. ej. la copia de respaldo de una tablet nueva sin red).
 */
export async function resolveTemplateRef(template) {
  const code = typeof template?.code === 'string' ? template.code : null;
  const version = typeof template?.version === 'string' ? template.version : null;
  if (!code || !version) return { code, version, verified: false, reason: 'sin_plantilla' };
  if (!isSafeId(code) || !isSafeId(version)) return { code: null, version: null, verified: false, reason: 'invalida' };
  try {
    const stored = await evidence.getJson(templateKey(code, version));
    if (!stored) return { code, version, verified: false, reason: 'no_publicada' };
    return { code, version, verified: true, key: templateKey(code, version), sha256: stored.sha256 };
  } catch (err) {
    logger.warn('no se pudo comprobar la plantilla', { code, version, error: err?.name });
    return { code, version, verified: false, reason: 'error_al_comprobar' };
  }
}
