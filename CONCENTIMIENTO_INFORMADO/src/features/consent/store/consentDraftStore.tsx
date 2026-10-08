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
import type { SignatureBiometrics } from '@/features/consent/services/signatureBiometrics';
import type { ConsentTemplate, DecisionChoice, SignerRole } from '@/features/consent/types/consent';
import { createConsentId } from '@/services/ids';
import { useAuth } from '@/store/authStore';

/**
 * Holds the consent being filled while the user moves through
 * fill → preview → handoff → professional signature → done.
 *
 * Signature PNGs are far too large to pass as route params, so the flow's
 * screens read and write this shared draft instead. It lives in the consent
 * route group's layout, so leaving the group discards it.
 */

/** What the audit log records about how the patient read the document. */
export type ReadingMetrics = {
  timeSpentReadingSec: number;
  hasScrolledToBottom: boolean;
};

/** Outcome of filing this consent (log + PDF) with the backend, for the closing screen. */
export type SubmissionState = ConsentSubmission;

type ConsentDraftState = {
  /**
   * The document as it will be signed: the form, plus the accept or decline
   * text once the patient has chosen. Everything downstream (preview, PDF,
   * audit log) uses this one.
   */
  template: ConsentTemplate | null;
  /** The form exactly as published, without any decision text. */
  baseTemplate: ConsentTemplate | null;
  /** The patient's answer; null until chosen (or when the form has no decision step). */
  decision: DecisionChoice | null;
  setDecision: (choice: DecisionChoice | null) => void;
  /**
   * Identifies this signing session across the PDF, the audit log and the
   * flow's screens. Minted when the template loads, because the log's sort key
   * needs it and the device may be offline when the consent is signed.
   */
  consentId: string | null;
  values: Record<string, string>;
  signatures: Record<string, string>;
  /** Stroke capture per signature key — the log's `biometrics_json`. */
  biometrics: Record<string, SignatureBiometrics>;
  /**
   * Local URI of the generated PDF. Kept here rather than passed as a route
   * param: under Expo Go the cache path contains percent-encoded segments
   * (`…/ExperienceData/%2540anonymous%252Fslug/…`), and round-tripping that
   * through the router's URL encoding corrupts it into a path that no longer
   * exists — which is what made expo-sharing reject it.
   */
  generatedPdfUri: string | null;
  /** Set once the audit log for this consent has been handed to the service. */
  submission: SubmissionState | null;
  /** Set once the signed PDF has been offered to S3. */
  isLoading: boolean;
  error: string | null;
  loadTemplate: (code: string) => Promise<void>;
  setValue: (key: string, value: string) => void;
  setSignature: (key: string, dataUrl: string | null) => void;
  setBiometrics: (key: string, biometrics: SignatureBiometrics | null) => void;
  setGeneratedPdfUri: (uri: string) => void;
  setSubmission: (submission: SubmissionState | null) => void;
  /** Called when the patient's scroll reaches the end of the document. */
  markScrolledToBottom: () => void;
  /** Stops the reading clock — the patient has confirmed the document. */
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

export function ConsentDraftProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [baseTemplate, setTemplate] = useState<ConsentTemplate | null>(null);
  const [decision, setDecisionState] = useState<DecisionChoice | null>(null);

  const template = useMemo<ConsentTemplate | null>(() => {
    if (!baseTemplate?.decision || !decision) return baseTemplate;
    return { ...baseTemplate, blocks: [...baseTemplate.blocks, ...baseTemplate.decision[decision].blocks] };
  }, [baseTemplate, decision]);
  const [consentId, setConsentId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [signatures, setSignatures] = useState<Record<string, string>>({});
  const [biometrics, setBiometricsState] = useState<Record<string, SignatureBiometrics>>({});
  const [generatedPdfUri, setGeneratedPdfUri] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SubmissionState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reading metrics live in refs: they change on every scroll event and on
  // every tick of the clock, and none of that should re-render the document
  // the patient is currently reading.
  const readingStartedAt = useRef<number | null>(null);
  const readingEndedAt = useRef<number | null>(null);
  const scrolledToBottom = useRef(false);

  const loadTemplate = useCallback(
    async (code: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const loaded = await getConsentTemplate(code);
        if (!loaded) {
          setError('No se encontró el consentimiento solicitado.');
          setTemplate(null);
          return;
        }

        // Only professional data comes from the session — the logged-in
        // account is the attending professional, not the patient. Patient
        // fields stay empty and are typed in for each patient seen.
        const prefilled: Record<string, string> = {};
        for (const field of loaded.fields) {
          if (field.prefill === 'professional.name') prefilled[field.key] = user?.name ?? '';
          if (field.prefill === 'professional.email') prefilled[field.key] = user?.email ?? '';
        }

        setTemplate(loaded);
        setDecisionState(null);
        setConsentId(createConsentId());
        setValues(prefilled);
        setSignatures({});
        setBiometricsState({});
        setGeneratedPdfUri(null);
        setSubmission(null);

        // The reading clock starts the moment the document is on screen.
        readingStartedAt.current = Date.now();
        readingEndedAt.current = null;
        scrolledToBottom.current = false;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo cargar el consentimiento');
        setTemplate(null);
      } finally {
        setIsLoading(false);
      }
    },
    [user]
  );

  // Changing the answer invalidates the patient's signature: they signed a
  // document with the other text.
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
      if (!template) return false;
      // A form with a decision step cannot be signed until the patient answers.
      if (template.decision && !decision) return false;

      // Field values are the patient's responsibility; the professional stage
      // only gates on its own signatures.
      const fieldsOk =
        role !== 'patient' ||
        template.fields.every(
          (field) => !field.required || (values[field.key] ?? '').trim().length > 0
        );

      const signaturesOk = template.signatures
        .filter((slot) => slot.signer === role)
        .every((slot) => !slot.required || Boolean(signatures[slot.key]));

      return fieldsOk && signaturesOk;
    },
    [template, decision, values, signatures]
  );

  const reset = useCallback(() => {
    setTemplate(null);
    setDecisionState(null);
    setConsentId(null);
    setValues({});
    setSignatures({});
    setBiometricsState({});
    setGeneratedPdfUri(null);
    setSubmission(null);
    setError(null);
    readingStartedAt.current = null;
    readingEndedAt.current = null;
    scrolledToBottom.current = false;
  }, []);

  const value = useMemo<ConsentDraftState>(
    () => ({
      template,
      baseTemplate,
      decision,
      setDecision,
      consentId,
      values,
      signatures,
      biometrics,
      generatedPdfUri,
      submission,
      isLoading,
      error,
      loadTemplate,
      setValue,
      setSignature,
      setBiometrics,
      setGeneratedPdfUri,
      setSubmission,
      markScrolledToBottom,
      markReadingComplete,
      getReadingMetrics,
      isStageComplete,
      reset,
    }),
    [
      template,
      baseTemplate,
      decision,
      setDecision,
      consentId,
      values,
      signatures,
      biometrics,
      generatedPdfUri,
      submission,
      isLoading,
      error,
      loadTemplate,
      setValue,
      setSignature,
      setBiometrics,
      markScrolledToBottom,
      markReadingComplete,
      getReadingMetrics,
      isStageComplete,
      reset,
    ]
  );

  return <ConsentDraftContext.Provider value={value}>{children}</ConsentDraftContext.Provider>;
}
