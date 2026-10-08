import type {
  ConsentBlock,
  ConsentDecision,
  DecisionOption,
  ConsentField,
  ConsentTemplate,
  FooterCell,
  SignatureSlot,
} from '@/features/consent/types/consent';

/**
 * The seam between "template as JSON" and "template as typed object".
 * Today it is fed the bundled templates; later, an HTTP response body
 * from the web template builder. Both paths validate identically, so a
 * malformed template fails here rather than halfway through a PDF render.
 */

class TemplateParseError extends Error {
  constructor(message: string) {
    super(`Plantilla inválida: ${message}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TemplateParseError(`${label} debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TemplateParseError(`${label} debe ser un texto no vacío`);
  }
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TemplateParseError(`${label} debe ser una lista`);
  }
  return value;
}

function parseBlock(raw: unknown, index: number): ConsentBlock {
  const block = asRecord(raw, `bloque ${index}`);
  const type = asString(block.type, `bloque ${index}.type`);

  switch (type) {
    case 'heading':
      return {
        type: 'heading',
        text: asString(block.text, `bloque ${index}.text`),
        level: block.level === 2 || block.level === 3 ? block.level : 1,
      };
    case 'paragraph':
      return {
        type: 'paragraph',
        text: asString(block.text, `bloque ${index}.text`),
        indent: clampIndent(block.indent),
        emphasis: block.emphasis === 'bold' || block.emphasis === 'italic' ? block.emphasis : undefined,
      };
    case 'list':
      return {
        type: 'list',
        items: asArray(block.items, `bloque ${index}.items`).map((item, i) =>
          asString(item, `bloque ${index}.items[${i}]`)
        ),
        ordered: block.ordered === true,
        indent: clampIndent(block.indent),
      };
    case 'note':
      return { type: 'note', text: asString(block.text, `bloque ${index}.text`) };
    case 'spacer':
      return { type: 'spacer' };
    default:
      throw new TemplateParseError(`tipo de bloque desconocido "${type}" en la posición ${index}`);
  }
}

function clampIndent(value: unknown): 0 | 1 | 2 | 3 {
  if (value === 1 || value === 2 || value === 3) return value;
  return 0;
}

function parseField(raw: unknown, index: number): ConsentField {
  const field = asRecord(raw, `campo ${index}`);
  const input = field.input === 'number' ? 'number' : 'text';
  const prefill =
    field.prefill === 'professional.name' || field.prefill === 'professional.email'
      ? field.prefill
      : undefined;

  return {
    key: asString(field.key, `campo ${index}.key`),
    label: asString(field.label, `campo ${index}.label`),
    input,
    required: field.required !== false,
    placeholder: typeof field.placeholder === 'string' ? field.placeholder : undefined,
    prefill,
  };
}

function parseSignature(raw: unknown, index: number): SignatureSlot {
  const slot = asRecord(raw, `firma ${index}`);
  if (slot.signer !== 'patient' && slot.signer !== 'professional') {
    throw new TemplateParseError(`firma ${index}.signer debe ser "patient" o "professional"`);
  }
  return {
    key: asString(slot.key, `firma ${index}.key`),
    label: asString(slot.label, `firma ${index}.label`),
    signer: slot.signer,
    required: slot.required !== false,
  };
}

function parseFooterCell(raw: unknown, index: number): FooterCell {
  const cell = asRecord(raw, `footer ${index}`);
  const type = asString(cell.type, `footer ${index}.type`);

  switch (type) {
    case 'signature':
      return { type: 'signature', key: asString(cell.key, `footer ${index}.key`) };
    case 'field':
      return { type: 'field', key: asString(cell.key, `footer ${index}.key`) };
    case 'date':
      return {
        type: 'date',
        label: typeof cell.label === 'string' ? cell.label : undefined,
      };
    default:
      throw new TemplateParseError(`tipo de celda de footer desconocido "${type}" (${index})`);
  }
}

function parseDecisionOption(raw: unknown, label: string): DecisionOption {
  const option = asRecord(raw, label);
  const blocks = asArray(option.blocks, `${label}.blocks`).map(parseBlock);
  if (blocks.length === 0) throw new TemplateParseError(`${label}.blocks no puede estar vacío`);
  return { label: asString(option.label, `${label}.label`), blocks };
}

function parseDecision(raw: unknown): ConsentDecision | undefined {
  if (raw === undefined || raw === null) return undefined;
  const decision = asRecord(raw, 'decision');
  return {
    prompt: asString(decision.prompt, 'decision.prompt'),
    accept: parseDecisionOption(decision.accept, 'decision.accept'),
    decline: parseDecisionOption(decision.decline, 'decision.decline'),
  };
}

export function parseConsentTemplate(raw: unknown): ConsentTemplate {
  const doc = asRecord(raw, 'plantilla');

  const signatures = asArray(doc.signatures ?? [], 'signatures').map(parseSignature);
  if (signatures.length === 0) {
    throw new TemplateParseError('debe declarar al menos una firma');
  }

  const fields = asArray(doc.fields ?? [], 'fields').map(parseField);

  const footer =
    doc.footer === undefined
      ? // Sensible default: every signature, then the date.
        [
          ...signatures.map((slot): FooterCell => ({ type: 'signature', key: slot.key })),
          { type: 'date' } as FooterCell,
        ]
      : asArray(doc.footer, 'footer').map(parseFooterCell);

  // A footer cell pointing at a slot or field that does not exist would render
  // as a silent blank in a signed document — fail loudly instead.
  for (const cell of footer) {
    if (cell.type === 'signature' && !signatures.some((slot) => slot.key === cell.key)) {
      throw new TemplateParseError(`footer referencia la firma inexistente "${cell.key}"`);
    }
    if (cell.type === 'field' && !fields.some((field) => field.key === cell.key)) {
      throw new TemplateParseError(`footer referencia el campo inexistente "${cell.key}"`);
    }
  }

  return {
    code: asString(doc.code, 'code'),
    version: asString(doc.version, 'version'),
    title: asString(doc.title, 'title'),
    examType: typeof doc.examType === 'string' && doc.examType.length > 0 ? doc.examType : undefined,
    effectiveDate: asString(doc.effectiveDate, 'effectiveDate'),
    blocks: asArray(doc.blocks, 'blocks').map(parseBlock),
    fields,
    signatures,
    footer,
    decision: parseDecision(doc.decision),
  };
}

export function parseConsentTemplateJson(json: string): ConsentTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new TemplateParseError('el documento no es JSON válido');
  }
  return parseConsentTemplate(raw);
}
