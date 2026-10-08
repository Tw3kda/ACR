/**
 * The shape a consent template arrives in — today bundled with the app,
 * in Phase 2 verbatim from the web template builder's JSON API. Nothing
 * downstream (renderer, PDF pipeline) knows which source it came from.
 */

/** Indentation level: 0 = flush left, each step ≈ one tab stop. */
export type IndentLevel = 0 | 1 | 2 | 3;

export type ConsentBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string; indent?: IndentLevel; emphasis?: 'bold' | 'italic' }
  | { type: 'list'; items: string[]; ordered?: boolean; indent?: IndentLevel }
  | { type: 'note'; text: string }
  | { type: 'spacer' };

/** A value supplied before signing. */
export type ConsentField = {
  key: string;
  label: string;
  input: 'text' | 'number';
  required?: boolean;
  placeholder?: string;
  /**
   * Fills the field from the session and locks it.
   *
   * The logged-in account is the **attending professional**, not the patient —
   * one clinic device serves many patients over a shift. So patient data is
   * always typed in; only professional data can come from the session.
   */
  prefill?: 'professional.name' | 'professional.email';
};

/** Who provides a signature — this drives the patient → professional handoff. */
export type SignerRole = 'patient' | 'professional';

/** One signature the document requires, captured at the end of the document. */
export type SignatureSlot = {
  key: string;
  label: string;
  signer: SignerRole;
  required?: boolean;
};

/**
 * One cell of the closing row — the paper form's
 * "Firma del paciente | Cédula | Firma del profesional | Fecha y hora" strip.
 * Declared per template so a form with a different closing row needs no code.
 */
export type FooterCell =
  | { type: 'signature'; key: string }
  | { type: 'field'; key: string }
  | { type: 'date'; label?: string };

/** One of the two answers the patient can give before signing. */
export type DecisionOption = {
  /** Button text, e.g. "Acepto" / "No acepto". */
  label: string;
  /** Text appended to the document when this option is chosen. */
  blocks: ConsentBlock[];
};

/**
 * Accept / decline step before signing. The patient reads the document, picks
 * one, and signs the same form with the chosen option's text appended — a
 * refusal is a signed document too (CONSENT_DECLINED).
 */
export type ConsentDecision = {
  prompt: string;
  accept: DecisionOption;
  decline: DecisionOption;
};

/** What the patient answered. */
export type DecisionChoice = 'accept' | 'decline';

export type ConsentTemplate = {
  /** Header */
  code: string;
  version: string;
  title: string;
  /**
   * What procedure this form covers (`TOMA_DE_MUESTRAS`, …). Recorded in the
   * audit log as `subject.medical_exam_type`. Optional for older templates;
   * those fall back to the deployment's EXPO_PUBLIC_MEDICAL_EXAM_TYPE.
   */
  examType?: string;
  /** When this revision of the form was created. Printed in the masthead. */
  effectiveDate: string;
  /** Content */
  blocks: ConsentBlock[];
  /** Fill + sign */
  fields: ConsentField[];
  signatures: SignatureSlot[];
  /** Closing row. Defaults to every signature followed by the date. */
  footer: FooterCell[];
  /** Optional accept/decline step. Without it the form can only be accepted. */
  decision?: ConsentDecision;
};

/** Everything the patient supplied, keyed by field/signature `key`. */
export type ConsentSubmission = {
  values: Record<string, string>;
  signatures: Record<string, string>;
  signedAt: Date;
};
