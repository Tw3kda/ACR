import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { DocumentHtmlView } from '@/features/consent/components/DocumentHtmlView';
import { buildConsentHtml } from '@/features/consent/services/documentHtml';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';

/**
 * The patient reviews every document exactly as it will be signed — same HTML
 * the PDFs are rendered from — one at a time, and confirms them all at once.
 */
export default function ConsentPreviewScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { templates, values, signatures, decision, markReadingComplete } = useConsentDraft();

  const signedAt = useMemo(() => new Date(), []);
  const [index, setIndex] = useState(0);

  const htmls = useMemo(
    () => templates.map((form) => buildConsentHtml(form, { values, signatures, signedAt, decision })),
    [templates, values, signatures, signedAt, decision]
  );

  function handleConfirm() {
    // The patient is done with the documents — stop the reading clock that
    // feeds `time_spent_reading_sec` in the audit log.
    markReadingComplete();
    router.push({ pathname: '/(app)/consent/[code]/handoff', params: { code } });
  }

  if (templates.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>No hay un consentimiento en curso.</Text>
      </View>
    );
  }

  const total = templates.length;
  const current = Math.min(index, total - 1);

  return (
    <View style={styles.screen}>
      <View style={styles.callout}>
        <Text style={styles.calloutTitle}>
          {total > 1 ? `Revise los ${total} documentos antes de confirmar` : 'Revise el documento antes de confirmar'}
        </Text>
        <Text style={styles.calloutBody}>
          Esta es una vista preliminar. Verifique sus datos y su firma; al confirmar,{' '}
          {total > 1 ? 'los documentos quedan listos' : 'el documento queda listo'} para la firma del
          profesional.
        </Text>
      </View>

      {total > 1 ? (
        <View style={styles.pager}>
          <Pressable
            onPress={() => setIndex(Math.max(current - 1, 0))}
            disabled={current === 0}
            hitSlop={8}
          >
            <Text style={[styles.pagerLink, current === 0 && styles.pagerDisabled]}>‹ Anterior</Text>
          </Pressable>
          <Text style={styles.pagerLabel}>
            Documento {current + 1} de {total} · {templates[current].code}
          </Text>
          <Pressable
            onPress={() => setIndex(Math.min(current + 1, total - 1))}
            disabled={current === total - 1}
            hitSlop={8}
          >
            <Text style={[styles.pagerLink, current === total - 1 && styles.pagerDisabled]}>
              Siguiente ›
            </Text>
          </Pressable>
        </View>
      ) : null}

      <DocumentHtmlView key={templates[current].code} html={htmls[current]} />

      <View style={styles.actions}>
        <Button
          label={total > 1 ? `Confirmar los ${total} documentos` : 'Confirmar documento'}
          onPress={handleConfirm}
        />

        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.secondary}>
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
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#d7e1e1',
  },
  pagerLabel: { fontSize: 13, fontWeight: '700', color: '#12212b' },
  pagerLink: { fontSize: 14, fontWeight: '600', color: '#0e7a82' },
  pagerDisabled: { color: '#9fb4b4' },
  actions: {
    padding: 16,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#d7e1e1',
    backgroundColor: '#fff',
  },
  secondary: { alignSelf: 'center', paddingVertical: 4, paddingBottom: 40 },
  secondaryLabel: { color: '#0e7a82', fontWeight: '600', fontSize: 14 },
  error: { fontSize: 13, color: '#dc2626', textAlign: 'center' },
});
