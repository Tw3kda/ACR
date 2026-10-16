import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ConsentSubmission } from '@/features/consent/services/consentSubmitService';
import { getConsentTemplate } from '@/features/consent/services/consentRepository';
import {
  fieldsFilledBy,
  isFieldRequired,
  isSignatureRequired,
} from '@/features/consent/services/fieldRules';
import type { SignatureBiometrics } from '@/features/consent/services/signatureBiometrics';
import type {
  ConsentField,
  ConsentTemplate,
  DecisionChoice,
  SignatureSlot,
  SignerRole,
} from '@/features/consent/types/consent';
import { createConsentId } from '@/services/ids';
import { useAuth } from '@/store/authStore';

/**
 * Holds the consents being filled while the user moves through
 * fill → preview → handoff → professional signature → done.
 *
 * One session can cover several forms at once: the patient reads all of them,
 * answers once, types their data once and signs once; at the end each form
 * becomes its own PDF and its own audit record, all with the same data and
 * signatures. A single form is just a session of one.
 *
 * Signature PNGs are far too large to pass as route params, so the flow's
 * screens read and write this shared draft instead. It lives in the consent
 * route group's layout, so leaving the group discards it.
 */

/** What the audit log records about how the patient read the documents. */
export type ReadingMetrics = {
  timeSpentReadingSec: number;
  hasScrolledToBottom: boolean;
};

/** Outcome of filing one consent (log + PDF) with the backend, for the closing screen. */
export type SubmissionState = ConsentSubmission;

/** The accept / decline question shown once for the whole session. */
export type DecisionStep = {
  prompt: string;
  acceptLabel: string;
  declineLabel: string;
};

/** Route param for a session: the selected form codes, comma-separated. */
export const SESSION_CODES_SEPARATOR = ',';
export const sessionKey = (codes: string[]) => codes.join(SESSION_CODES_SEPARATOR);
export const parseSessionKey = (key: string | undefined) =>
  (key ?? '').split(SESSION_CODES_SEPARATOR).filter(Boolean);

type ConsentDraftState = {
  /**
   * The documents as they will be signed: each form, plus its own accept or
   * decline text once the patient has chosen. Everything downstream (preview,
   * PDF, audit log) uses these.
   */
  templates: ConsentTemplate[];
  /** The forms exactly as published, without any decision text. */
  baseTemplates: ConsentTemplate[];
  /** Codes of the loaded session, in order (the route param it was loaded from). */
  loadedKey: string | null;
  /** The single question covering every form that has a decision step; null if none has. */
  decisionStep: DecisionStep | null;
  /** The patient's answer; null until chosen (or when no form has a decision step). */
  decision: DecisionChoice | null;
  setDecision: (choice: DecisionChoice | null) => void;
  /**
   * One id per form, aligned with `templates`. Minted when the forms load,
   * because the log's sort key needs it and the device may be offline when
   * the consents are signed.
   */
  consentIds: string[];
  /** Fields of all forms, de-duplicated by key: the patient types each one once. */
  fields: ConsentField[];
  /** Signature slots of all forms, de-duplicated by key: each signer signs each slot once. */
  signatureSlots: SignatureSlot[];
  values: Record<string, string>;
  signatures: Record<string, string>;
  /** Stroke capture per signature key — the log's `biometrics_json`. */
  biometrics: Record<string, SignatureBiometrics>;
  /**
   * Local URI of each generated PDF, aligned with `templates`. Kept here
   * rather than passed as a route param: under Expo Go the cache path contains
   * percent-encoded segments (`…/ExperienceData/%2540anonymous%252Fslug/…`),
   * and round-tripping that through the router's URL encoding corrupts it into
   * a path that no longer exists — which is what made expo-sharing reject it.
   */
  generatedPdfUris: (string | null)[];
  /** Filing outcome of each consent, aligned with `templates`; null until known. */
  submissions: (SubmissionState | null)[];
  isLoading: boolean;
  error: string | null;
  loadTemplates: (codes: string[]) => Promise<void>;
  setValue: (key: string, value: string) => void;
  setSignature: (key: string, dataUrl: string | null) => void;
  setBiometrics: (key: string, biometrics: SignatureBiometrics | null) => void;
  setGeneratedPdfUris: (uris: string[]) => void;
  setSubmission: (index: number, submission: SubmissionState | null) => void;
  /** Called when the patient's scroll reaches the end of the documents. */
  markScrolledToBottom: () => void;
  /** Stops the reading clock — the patient has confirmed the documents. */
  markReadingComplete: () => void;
  /** Snapshot of the reading metrics for the audit log. */
  getReadingMetrics: () => ReadingMetrics;
  /** True when every required field and every signature for `role` is present. */
  isStageComplete: (role: SignerRole) => boolean;
  reset: () => void;
};

const ConsentDraftContext = createContext<ConsentDraftState | undefined>(undefined);

export function useConsentDraft(): ConsentDraftState {
  const ctx = useContext(ConsentDraftContext);
  if (!ctx) {
    throw new Error('useConsentDraft must be used within a ConsentDraftProvider');
  }
  return ctx;
}

/** First occurrence of each key wins: the forms share fields such as name and ID. */
function uniqueByKey<T extends { key: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.key) ? false : (seen.add(item.key), true)));
}

/**
 * With one form, its own question. With several, a single question for all of
 * them — the answer applies to every form that has a decision step.
 */
function buildDecisionStep(forms: ConsentTemplate[]): DecisionStep | null {
  const withDecision = forms.filter((form) => form.decision);
  const first = withDecision[0]?.decision;
  if (!first) return null;
  if (forms.length === 1) {
    return { prompt: first.prompt, acceptLabel: first.accept.label, declineLabel: first.decline.label };
  }
  return {
    prompt: `¿Autoriza la realización de los procedimientos descritos en estos ${forms.length} documentos?`,
    acceptLabel: first.accept.label,
    declineLabel: first.decline.label,
  };
}

export function ConsentDraftProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [baseTemplates, setBaseTemplates] = useState<ConsentTemplate[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [decision, setDecisionState] = useState<DecisionChoice | null>(null);

  const templates = useMemo<ConsentTemplate[]>(
    () =>
      baseTemplates.map((form) =>
        form.decision && decision
          ? { ...form, blocks: [...form.blocks, ...form.decision[decision].blocks] }
          : form
      ),
    [baseTemplates, decision]
  );
  const decisionStep = useMemo(() => buildDecisionStep(baseTemplates), [baseTemplates]);
  const fields = useMemo(() => uniqueByKey(baseTemplates.flatMap((form) => form.fields)), [baseTemplates]);
  const signatureSlots = useMemo(
    () => uniqueByKey(baseTemplates.flatMap((form) => form.signatures)),
    [baseTemplates]
  );

  const [consentIds, setConsentIds] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [signatures, setSignatures] = useState<Record<string, string>>({});
  const [biometrics, setBiometricsState] = useState<Record<string, SignatureBiometrics>>({});
  const [generatedPdfUris, setGeneratedPdfUris] = useState<(string | null)[]>([]);
  const [submissions, setSubmissions] = useState<(SubmissionState | null)[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reading metrics live in refs: they change on every scroll event and on
  // every tick of the clock, and none of that should re-render the documents
  // the patient is currently reading.
  const readingStartedAt = useRef<number | null>(null);
  const readingEndedAt = useRef<number | null>(null);
  const scrolledToBottom = useRef(false);

  const loadTemplates = useCallback(
    async (codes: string[]) => {
      setIsLoading(true);
      setError(null);
      try {
        const loaded = await Promise.all(codes.map((code) => getConsentTemplate(code)));
        const missing = codes.filter((_, i) => !loaded[i]);
        if (missing.length > 0 || loaded.length === 0) {
          setError(`No se encontró el consentimiento solicitado${missing.length ? ` (${missing.join(', ')})` : ''}.`);
          setBaseTemplates([]);
          setLoadedKey(null);
          return;
        }
        const forms = loaded as ConsentTemplate[];

        // Only professional data comes from the session — the logged-in
        // account is the attending professional, not the patient. Patient
        // fields stay empty and are typed in for each patient seen.
        const prefilled: Record<string, string> = {};
        for (const field of forms.flatMap((form) => form.fields)) {
          if (field.prefill === 'professional.name') prefilled[field.key] = user?.name ?? '';
          if (field.prefill === 'professional.email') prefilled[field.key] = user?.email ?? '';
        }

        setBaseTemplates(forms);
        setLoadedKey(sessionKey(codes));
        setDecisionState(null);
        setConsentIds(forms.map(() => createConsentId()));
        setValues(prefilled);
        setSignatures({});
        setBiometricsState({});
        setGeneratedPdfUris(forms.map(() => null));
        setSubmissions(forms.map(() => null));

        // The reading clock starts the moment the documents are on screen.
        readingStartedAt.current = Date.now();
        readingEndedAt.current = null;
        scrolledToBottom.current = false;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar el consentimiento');
        setBaseTemplates([]);
        setLoadedKey(null);
      } finally {
        setIsLoading(false);
      }
    },
    [user]
  );

  // Changing the answer invalidates the patient's signature: they signed
  // documents with the other text.
  const setDecision = useCallback((choice: DecisionChoice | null) => {
    setDecisionState(choice);
    setSignatures({});
    setBiometricsState({});
  }, []);

  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setSignature = useCallback((key: string, dataUrl: string | null) => {
    setSignatures((prev) => {
      const next = { ...prev };
      if (dataUrl) next[key] = dataUrl;
      else delete next[key];
      return next;
    });
  }, []);

  const setBiometrics = useCallback((key: string, next: SignatureBiometrics | null) => {
    setBiometricsState((prev) => {
      const updated = { ...prev };
      if (next && next.strokes.length > 0) updated[key] = next;
      else delete updated[key];
      return updated;
    });
  }, []);

  const setSubmission = useCallback((index: number, next: SubmissionState | null) => {
    setSubmissions((prev) => prev.map((item, i) => (i === index ? next : item)));
  }, []);

  const markScrolledToBottom = useCallback(() => {
    scrolledToBottom.current = true;
  }, []);

  const markReadingComplete = useCallback(() => {
    // First confirmation wins: going back to correct a field must not restart
    // or extend the measured reading time.
    if (readingEndedAt.current === null) readingEndedAt.current = Date.now();
  }, []);

  const getReadingMetrics = useCallback((): ReadingMetrics => {
    const startedAt = readingStartedAt.current;
    const endedAt = readingEndedAt.current ?? Date.now();
    return {
      timeSpentReadingSec: startedAt === null ? 0 : Math.round((endedAt - startedAt) / 1000),
      hasScrolledToBottom: scrolledToBottom.current,
    };
  }, []);

  const isStageComplete = useCallback(
    (role: SignerRole) => {
      if (baseTemplates.length === 0) return false;
      // Forms with a decision step cannot be signed until the patient answers.
      if (decisionStep && !decision) return false;

      // Each side answers for its own fields — the patient's before signing,
      // the professional's (e.g. the decision-ability assessment) at the end.
      // Whether one is required can depend on another answer.
      const fieldsOk = fieldsFilledBy(fields, role, decision).every(
        (field) =>
          !isFieldRequired(field, values, decision) || (values[field.key] ?? '').trim().length > 0
      );

      const signaturesOk = signatureSlots
        .filter((slot) => slot.signer === role)
        .every((slot) => !isSignatureRequired(slot, values) || Boolean(signatures[slot.key]));

      return fieldsOk && signaturesOk;
    },
    [baseTemplates, decisionStep, decision, fields, signatureSlots, values, signatures]
  );

  const reset = useCallback(() => {
    setBaseTemplates([]);
    setLoadedKey(null);
    setDecisionState(null);
    setConsentIds([]);
    setValues({});
    setSignatures({});
    setBiometricsState({});
    setGeneratedPdfUris([]);
    setSubmissions([]);
    setError(null);
    readingStartedAt.current = null;
    readingEndedAt.current = null;
    scrolledToBottom.current = false;
  }, []);

  const value = useMemo<ConsentDraftState>(
    () => ({
      templates,
      baseTemplates,
      loadedKey,
      decisionStep,
      decision,
      setDecision,
      consentIds,
      fields,
      signatureSlots,
      values,
      signatures,
      biometrics,
      generatedPdfUris,
      submissions,
      isLoading,
      error,
      loadTemplates,
      setValue,
      setSignature,
      setBiometrics,
      setGeneratedPdfUris,
      setSubmission,
      markScrolledToBottom,
      markReadingComplete,
      getReadingMetrics,
      isStageComplete,
      reset,
    }),
    [
      templates,
      baseTemplates,
      loadedKey,
      decisionStep,
      decision,
      setDecision,
      consentIds,
      fields,
      signatureSlots,
      values,
      signatures,
      biometrics,
      generatedPdfUris,
      submissions,
      isLoading,
      error,
      loadTemplates,
      setValue,
      setSignature,
      setBiometrics,
      setSubmission,
      markScrolledToBottom,
      markReadingComplete,
      getReadingMetrics,
      isStageComplete,
      reset,
    ]
  );

  return <ConsentDraftContext.Provider value={value}>{children}</ConsentDraftContext.Provider>;
}
