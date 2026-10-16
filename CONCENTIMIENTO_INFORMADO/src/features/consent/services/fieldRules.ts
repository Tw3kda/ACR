import type {
  ConsentField,
  DecisionChoice,
  RequiredWhen,
  SignatureSlot,
  SignerRole,
} from '@/features/consent/types/consent';

/**
 * When a field is shown and when it must be filled. One place for the rules,
 * so the form, the "Continuar" gate and the PDF never disagree.
 */

/** A multiple-choice answer is stored as one string, choices joined by this. */
export const MULTI_SEPARATOR = '; ';

export function selectedOptions(value: string | undefined): string[] {
  return (value ?? '').split(MULTI_SEPARATOR).filter(Boolean);
}

/** True when the field the condition points at currently holds one of its values. */
export function conditionMet(condition: RequiredWhen, values: Record<string, string>): boolean {
  const chosen = selectedOptions(values[condition.key]);
  return chosen.some((option) => condition.in.includes(option));
}

/** A field tied to one answer of the decision step only exists with that answer. */
export function isFieldVisible(field: ConsentField, decision: DecisionChoice | null): boolean {
  return !field.decision || field.decision === decision;
}

export function isFieldRequired(
  field: ConsentField,
  values: Record<string, string>,
  decision: DecisionChoice | null
): boolean {
  if (!isFieldVisible(field, decision)) return false;
  if (field.requiredWhen) return conditionMet(field.requiredWhen, values);
  return field.required !== false;
}

export function isSignatureRequired(slot: SignatureSlot, values: Record<string, string>): boolean {
  if (slot.requiredWhen) return conditionMet(slot.requiredWhen, values);
  return slot.required !== false;
}

/** Fields each side fills: the patient (or their representative) before signing, or the professional. */
export function fieldsFilledBy(
  fields: ConsentField[],
  role: SignerRole,
  decision: DecisionChoice | null
): ConsentField[] {
  return fields.filter(
    (field) => (field.filledBy ?? 'patient') === role && isFieldVisible(field, decision)
  );
}
