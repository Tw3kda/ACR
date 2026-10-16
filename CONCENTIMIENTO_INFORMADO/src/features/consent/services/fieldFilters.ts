import type { ConsentField } from '@/features/consent/types/consent';

/**
 * Keys that identify the patient. Shared with the audit log builder, which
 * reads the same values as `subject.patient_id` / `subject.full_name`.
 */
export const PATIENT_ID_KEYS = ['cedula', 'documento', 'identificacion', 'patient_id'];
export const PATIENT_NAME_KEYS = ['nombre', 'nombre_paciente', 'paciente', 'full_name'];

/** Other people's names on the form (representative, witness…): same letters-only rule. */
const OTHER_NAME_KEYS = ['representante_nombre', 'testigo_nombre', 'persona_confianza'];

// Spelled out instead of \p{L}: Unicode property escapes are not guaranteed on
// every Hermes build. Covers Spanish names (accents, ü, ñ).
const NOT_A_NAME_CHAR = /[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]/g;

export type FieldFilter = 'digits' | 'name' | 'date' | null;

/** What a field accepts, from its input type and, for people's data, its key. */
export function filterFor(field: Pick<ConsentField, 'key' | 'input'>): FieldFilter {
  if (field.input === 'date') return 'date';
  if (field.input === 'number' || PATIENT_ID_KEYS.includes(field.key)) return 'digits';
  if (PATIENT_NAME_KEYS.includes(field.key) || OTHER_NAME_KEYS.includes(field.key)) return 'name';
  return null;
}

/** "12052014" → "12/05/2014", as the digits are typed. */
function formatDate(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join('/');
}

/**
 * Applied while typing (and to pasted text): characters a field does not
 * accept never appear. Cédula: digits only. Name: letters and single spaces.
 */
export function sanitizeFieldValue(field: Pick<ConsentField, 'key' | 'input'>, text: string): string {
  switch (filterFor(field)) {
    case 'digits':
      return text.replace(/\D/g, '');
    case 'name':
      return text.replace(NOT_A_NAME_CHAR, '').replace(/ {2,}/g, ' ').replace(/^ /, '');
    case 'date':
      return formatDate(text);
    default:
      return text;
  }
}
