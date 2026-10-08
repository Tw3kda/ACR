import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  listConsentTemplates,
  templateCatalogSource,
  type ConsentTemplateSummary,
} from '@/features/consent/services/consentRepository';
import { useConsentDraft } from '@/features/consent/store/consentDraftStore';

export default function ConsentListScreen() {
  const router = useRouter();
  const { reset } = useConsentDraft();
  const [templates, setTemplates] = useState<ConsentTemplateSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);

  // Being on the selection screen means no consent is in progress. Any draft
  // left over — from backing out of a form or finishing one — is discarded
  // here, so the next patient never starts on the previous patient's data.
  useFocusEffect(
    useCallback(() => {
      reset();
    }, [reset])
  );

  useEffect(() => {
    let cancelled = false;

    listConsentTemplates()
      .then((result) => {
        if (cancelled) return;
        setTemplates(result);
        // Without the server the list is the last one downloaded (or the copy
        // inside the APK): say so, since a newly published form won't be in it.
        const origin = templateCatalogSource();
        if (origin?.source === 'cache') {
          const when = origin.savedAt ? new Date(origin.savedAt).toLocaleString('es-CO') : '';
          setOfflineNotice(`Sin conexión: mostrando los consentimientos descargados ${when}.`.trim());
        } else if (origin?.source === 'bundled') {
          setOfflineNotice('Sin conexión: mostrando los consentimientos incluidos en la app.');
        } else {
          setOfflineNotice(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'No se pudieron cargar los consentimientos');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={templates}
      keyExtractor={(item) => item.code}
      renderItem={({ item }) => (
        <Pressable
          style={styles.card}
          onPress={() => router.push({ pathname: '/(app)/consent/[code]', params: { code: item.code } })}
        >
          <Text style={styles.cardTitle}>{item.title}</Text>
          <Text style={styles.cardMeta}>
            Código {item.code} · Versión {item.version}
          </Text>
        </Pressable>
      )}
      ListHeaderComponent={offlineNotice ? <Text style={styles.notice}>{offlineNotice}</Text> : null}
      ListEmptyComponent={<Text style={styles.empty}>No hay consentimientos disponibles.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  list: { padding: 20, gap: 12 },
  card: {
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d7e1e1',
    backgroundColor: '#fff',
  },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardMeta: { fontSize: 12, color: '#4e6870', marginTop: 4 },
  empty: { textAlign: 'center', color: '#4e6870', marginTop: 40 },
  notice: {
    fontSize: 13,
    color: '#7a4b00',
    backgroundColor: '#fff4e0',
    borderRadius: 8,
    padding: 10,
  },
});
