import { badRequest } from './errors.js';

/**
 * Validación de una plantilla de consentimiento. Mismas reglas que
 * `templateSchema.ts` de la app (CONCENTIMIENTO_INFORMADO): lo que se publica
 * aquí es exactamente lo que la tablet acepta, así que una plantilla mal formada
 * se rechaza al publicar y nunca llega a una tablet.
 *
 * Devuelve la plantilla normalizada (claves conocidas, valores por defecto
 * explícitos): eso es lo que se guarda y lo que se sirve.
 */

const CODE = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,32}$/;
const EXAM_TYPE = /^[A-Z0-9_]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (message, field) => badRequest(`Plantilla inválida: ${message}`, { details: { field } });

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function record(value, label) {
  if (!isRecord(value)) throw fail(`${label} debe ser un objeto`, label);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw fail(`${label} debe ser un texto no vacío`, label);
  return value;
}

function list(value, label) {
  if (!Array.isArray(value)) throw fail(`${label} debe ser una lista`, label);
  return value;
}

const indent = (v) => (v === 1 || v === 2 || v === 3 ? v : 0);

function parseBlock(raw, i) {
  const b = record(raw, `blocks[${i}]`);
  const type = text(b.type, `blocks[${i}].type`);
  switch (type) {
    case 'heading':
      return { type, text: text(b.text, `blocks[${i}].text`), level: b.level === 2 || b.level === 3 ? b.level : 1 };
    case 'paragraph': {
      const out = { type, text: text(b.text, `blocks[${i}].text`), indent: indent(b.indent) };
      if (b.emphasis === 'bold' || b.emphasis === 'italic') out.emphasis = b.emphasis;
      return out;
    }
    case 'list':
      return {
        type,
        items: list(b.items, `blocks[${i}].items`).map((it, j) => text(it, `blocks[${i}].items[${j}]`)),
        ordered: b.ordered === true,
        indent: indent(b.indent),
      };
    case 'note':
      return { type, text: text(b.text, `blocks[${i}].text`) };
    case 'spacer':
      return { type };
    default:
      throw fail(`tipo de bloque desconocido "${type}" en blocks[${i}]`, `blocks[${i}].type`);
  }
}

const INPUTS = new Set(['text', 'number', 'date', 'select']);

/**
 * `{ key, in: [...] }`: lo que la declara solo es obligatorio cuando el campo
 * `key` tiene uno de esos valores (en una selección múltiple, cuando incluye
 * alguno). Se comprueba después que `key` exista.
 */
function parseCondition(raw, label) {
  if (raw === undefined || raw === null) return undefined;
  const c = record(raw, label);
  const values = list(c.in, `${label}.in`).map((v, j) => text(v, `${label}.in[${j}]`));
  if (values.length === 0) throw fail(`${label}.in no puede estar vacío`, label);
  return { key: text(c.key, `${label}.key`), in: values };
}

function parseField(raw, i) {
  const f = record(raw, `fields[${i}]`);
  const input = INPUTS.has(f.input) ? f.input : 'text';
  const out = {
    key: text(f.key, `fields[${i}].key`),
    label: text(f.label, `fields[${i}].label`),
    input,
    required: f.required !== false,
  };
  if (typeof f.placeholder === 'string') out.placeholder = f.placeholder;
  if (f.prefill === 'professional.name' || f.prefill === 'professional.email') out.prefill = f.prefill;
  if (input === 'select') {
    out.options = list(f.options, `fields[${i}].options`).map((o, j) => text(o, `fields[${i}].options[${j}]`));
    if (out.options.length < 2) throw fail(`fields[${i}].options necesita al menos dos opciones`, `fields[${i}].options`);
    if (f.multiple === true) out.multiple = true;
  }
  // Quién lo diligencia: el paciente (o su representante) antes de firmar, o
  // el profesional en su paso de firma.
  if (f.filledBy === 'professional') out.filledBy = 'professional';
  // Solo se muestra (y solo se exige) con esa respuesta a la decisión.
  if (f.decision === 'accept' || f.decision === 'decline') out.decision = f.decision;
  const requiredWhen = parseCondition(f.requiredWhen, `fields[${i}].requiredWhen`);
  if (requiredWhen) out.requiredWhen = requiredWhen;
  return out;
}

function parseSignature(raw, i) {
  const s = record(raw, `signatures[${i}]`);
  if (s.signer !== 'patient' && s.signer !== 'professional') {
    throw fail(`signatures[${i}].signer debe ser "patient" o "professional"`, `signatures[${i}].signer`);
  }
  const out = {
    key: text(s.key, `signatures[${i}].key`),
    label: text(s.label, `signatures[${i}].label`),
    signer: s.signer,
    required: s.required !== false,
  };
  const requiredWhen = parseCondition(s.requiredWhen, `signatures[${i}].requiredWhen`);
  if (requiredWhen) out.requiredWhen = requiredWhen;
  return out;
}

function parseFooterCell(raw, i) {
  const c = record(raw, `footer[${i}]`);
  const type = text(c.type, `footer[${i}].type`);
  if (type === 'signature' || type === 'field') return { type, key: text(c.key, `footer[${i}].key`) };
  if (type === 'date') return typeof c.label === 'string' ? { type, label: c.label } : { type };
  throw fail(`tipo de celda desconocido "${type}" en footer[${i}]`, `footer[${i}].type`);
}

/**
 * Paso opcional de aceptar / rechazar antes de firmar. El texto de la opción
 * elegida se añade al documento, y el rechazo también se firma
 * (CONSENT_DECLINED).
 */
function parseDecision(raw) {
  if (raw === undefined || raw === null) return undefined;
  const d = record(raw, 'decision');
  const option = (value, label) => {
    const o = record(value, label);
    const blocks = list(o.blocks, `${label}.blocks`).map((b, i) => parseBlock(b, i));
    if (blocks.length === 0) throw fail(`${label}.blocks no puede estar vacío`, `${label}.blocks`);
    return { label: text(o.label, `${label}.label`), blocks };
  };
  return {
    prompt: text(d.prompt, 'decision.prompt'),
    accept: option(d.accept, 'decision.accept'),
    decline: option(d.decline, 'decision.decline'),
  };
}

export function parseTemplate(raw) {
  const doc = record(raw, 'plantilla');

  const code = text(doc.code, 'code');
  if (!CODE.test(code)) throw fail('code solo admite letras, números, ".", "_" y "-" (máx. 64)', 'code');
  const version = text(doc.version, 'version');
  if (!VERSION.test(version)) throw fail('version solo admite letras, números, ".", "_" y "-" (máx. 32)', 'version');
  const examType = text(doc.examType, 'examType');
  if (!EXAM_TYPE.test(examType)) throw fail('examType debe ir en MAYÚSCULAS_CON_GUIONES_BAJOS', 'examType');

  const signatures = list(doc.signatures ?? [], 'signatures').map(parseSignature);
  if (signatures.length === 0) throw fail('debe declarar al menos una firma', 'signatures');
  const fields = list(doc.fields ?? [], 'fields').map(parseField);

  const keys = [...fields.map((f) => f.key), ...signatures.map((s) => s.key)];
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw fail(`la clave "${dup}" está repetida entre campos y firmas`, 'fields');

  // Una condición debe apuntar a un campo de selección de esta plantilla y a
  // opciones que ese campo ofrece: si no, nunca se cumpliría.
  for (const item of [...fields, ...signatures]) {
    if (!item.requiredWhen) continue;
    const target = fields.find((f) => f.key === item.requiredWhen.key);
    if (!target || target.input !== 'select') {
      throw fail(`"${item.key}".requiredWhen apunta a "${item.requiredWhen.key}", que no es un campo de selección`, 'fields');
    }
    const unknown = item.requiredWhen.in.find((v) => !target.options.includes(v));
    if (unknown) throw fail(`"${item.key}".requiredWhen usa la opción inexistente "${unknown}"`, 'fields');
  }

  const footer =
    doc.footer === undefined
      ? [...signatures.map((s) => ({ type: 'signature', key: s.key })), { type: 'date' }]
      : list(doc.footer, 'footer').map(parseFooterCell);
  for (const cell of footer) {
    if (cell.type === 'signature' && !signatures.some((s) => s.key === cell.key)) {
      throw fail(`footer referencia la firma inexistente "${cell.key}"`, 'footer');
    }
    if (cell.type === 'field' && !fields.some((f) => f.key === cell.key)) {
      throw fail(`footer referencia el campo inexistente "${cell.key}"`, 'footer');
    }
  }

  const blocks = list(doc.blocks, 'blocks').map(parseBlock);
  if (blocks.length === 0) throw fail('blocks no puede estar vacío', 'blocks');

  const effectiveDate = text(doc.effectiveDate, 'effectiveDate');
  if (!DATE.test(effectiveDate)) throw fail('effectiveDate debe ser una fecha AAAA-MM-DD', 'effectiveDate');

  // Pestaña de la tablet: adultos o menores de edad. Sin el dato, adultos.
  const audience = doc.audience === 'minor' ? 'minor' : 'adult';

  const out = {
    code,
    version,
    title: text(doc.title, 'title'),
    examType,
    audience,
    effectiveDate,
    blocks,
    fields,
    signatures,
    footer,
  };
  const decision = parseDecision(doc.decision);
  if (decision) out.decision = decision;
  return out;
}
