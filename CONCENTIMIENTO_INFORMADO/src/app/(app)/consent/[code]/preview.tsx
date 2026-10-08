import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { DocumentHtmlView } from '@/features/consent/components/DocumentHtmlView';
import { buildConsentHtml } from '@/features/consent/services/documentHtml';
import {
  deleteConsentPdf,
  generateConsentPdf,
  shareConsentPdf,
} from '@/features/consent/services/pdfService';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';

export default function ConsentPreviewScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { template, values, signatures, markReadingComplete } = useConsentDraft();

  const signedAt = useMemo(() => new Date(), []);
  const [preliminaryUri, setPreliminaryUri] = useState<string | null>(null);
  const [isBuilding, setIsBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the cleanup path always sees the latest value.
  const preliminaryUriRef = useRef<string | null>(null);
  preliminaryUriRef.current = preliminaryUri;

  const submission = useMemo(
    () => ({ values, signatures, signedAt }),
    [values, signatures, signedAt]
  );

  const html = useMemo(
    () => (template ? buildConsentHtml(template, submission) : ''),
    [template, submission]
  );

  // Build the preliminary PDF once, on arrival.
  useEffect(() => {
    if (!template) return;
    let cancelled = false;

    // The preliminary draft is never logged, so its hash is not kept: only
    // the final, both-signatures PDF is an auditable artifact.
    generateConsentPdf(template, submission, 'preliminar')
      .then(({ uri }) => {
        if (cancelled) {
          // Screen left before the build finished — don't leak the file.
          deleteConsentPdf(uri);
          return;
        }
        setPreliminaryUri(uri);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'No se pudo generar la vista preliminar');
        }
      })
      .finally(() => {
        if (!cancelled) setIsBuilding(false);
      });

    return () => {
      cancelled = true;
    };
    // Intentionally built once per visit; `submission` is frozen by `signedAt`.
  }, [template, submission]);

  /** The preliminary is a patient-only draft — it must not outlive this screen. */
  const discardPreliminary = useCallback(() => {
    deleteConsentPdf(preliminaryUriRef.current);
    preliminaryUriRef.current = null;
    setPreliminaryUri(null);
  }, []);

  // Safety net for any exit path that isn't one of the two buttons.
  useEffect(() => () => deleteConsentPdf(preliminaryUriRef.current), []);

  function handleConfirm() {
    // The patient is done with the document — stop the reading clock that
    // feeds `time_spent_reading_sec` in the audit log.
    markReadingComplete();
    discardPreliminary();
    router.push({ pathname: '/(app)/consent/[code]/handoff', params: { code } });
  }

  function handleEdit() {
    discardPreliminary();
    router.back();
  }

  async function handleOpenPdf() {
    if (!preliminaryUri) return;
    try {
      await shareConsentPdf(preliminaryUri);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo abrir el PDF preliminar');
    }
  }

  if (!template) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>No hay un consentimiento en curso.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.callout}>
        <Text style={styles.calloutTitle}>Revise el documento antes de confirmar</Text>
        <Text style={styles.calloutBody}>
          Esta es una vista preliminar. Verifique sus datos y su firma; al confirmar, el documento
          queda listo para la firma del profesional.
        </Text>
      </View>

      <DocumentHtmlView html={html} />

      <View style={styles.actions}>
 
        <Button label="Confirmar documento" onPress={handleConfirm} />

        <Pressable onPress={handleEdit} hitSlop={8} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>No, corregir mis datos</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f6' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  callout: {
    backgroundColor: '#dceeee',
    borderLeftWidth: 3,
    borderLeftColor: '#0e7a82',
    padding: 12,
    gap: 4,
  },
  calloutTitle: { fontSize: 14, fontWeight: '700', color: '#0b5f66' },
  calloutBody: { fontSize: 13, lineHeight: 19, color: '#12212b' },
  actions: {
    padding: 16,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#d7e1e1',
    backgroundColor: '#fff',
  },
  buildingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center' },
  buildingLabel: { fontSize: 13, color: '#4e6870' },
  link: { color: '#0e7a82', fontWeight: '600', fontSize: 14, textAlign: 'center' },
  linkDisabled: { color: '#9fb4b4' },
  secondary: { alignSelf: 'center', paddingVertical: 4 , paddingBottom: 40},
  secondaryLabel: { color: '#0e7a82', fontWeight: '600', fontSize: 14 },
  error: { fontSize: 13, color: '#dc2626', textAlign: 'center' },
});
