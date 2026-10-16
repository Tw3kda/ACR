import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import {
  listConsentTemplates,
  templateCatalogSource,
  type ConsentTemplateSummary,
} from '@/features/consent/services/consentRepository';
import { sessionKey, useConsentDraft } from '@/features/consent/store/consentDraftStore';

export default function ConsentListScreen() {
  const router = useRouter();
  const { reset } = useConsentDraft();
  const [templates, setTemplates] = useState<ConsentTemplateSummary[]>([]);
  // Adults and minors sign different forms (a minor's needs the legal
  // representative): one tab each, and a selection never mixes the two.
  const [audience, setAudience] = useState<Audience>('adult');
  // Codes in the order they were tapped: that is the order the documents are
  // shown, signed and listed at the end.
  const [selected, setSelected] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);

  // Being on the selection screen means no consent is in progress. Any draft
  // left over — from backing out of a form or finishing one — is discarded
  // here, so the next patient never starts on the previous patient's data.
  useFocusEffect(
    useCallback(() => {
      reset();
      setSelected([]);
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

  const switchAudience = useCallback((next: Audience) => {
    setAudience(next);
    setSelected([]);
  }, []);

  const toggle = useCallback((code: string) => {
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
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

  const count = selected.length;
  const visible = templates.filter((t) => t.audience === audience);

  return (
    <View style={styles.screen}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {AUDIENCES.map((tab) => {
          const active = tab.value === audience;
          const total = templates.filter((t) => t.audience === tab.value).length;
          return (
            <Pressable
              key={tab.value}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => switchAudience(tab.value)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
              <Text style={[styles.tabCount, active && styles.tabLabelActive]}>
                {total} {total === 1 ? 'formato' : 'formatos'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        contentContainerStyle={styles.list}
        data={visible}
        keyExtractor={(item) => item.code}
        extraData={selected}
        renderItem={({ item }) => {
          const position = selected.indexOf(item.code);
          const isSelected = position >= 0;
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              style={[styles.card, isSelected && styles.cardSelected]}
              onPress={() => toggle(item.code)}
            >
              <View style={[styles.check, isSelected && styles.checkSelected]}>
                <Text style={styles.checkMark}>{isSelected ? String(position + 1) : ''}</Text>
              </View>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>{item.title}</Text>
                <Text style={styles.cardMeta}>
                  Código {item.code} · Versión {item.version}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ListHeaderComponent={
          <View style={styles.header}>
            {offlineNotice ? <Text style={styles.notice}>{offlineNotice}</Text> : null}
            <Text style={styles.hint}>
              Seleccione uno o varios consentimientos. El paciente los lee todos, responde una vez y
              firma una sola vez; se genera un PDF por cada uno.
            </Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {audience === 'minor'
              ? 'No hay consentimientos para menores de edad disponibles.'
              : 'No hay consentimientos disponibles.'}
          </Text>
        }
      />

      <View style={styles.footer}>
        <Button
          label={
            count === 0
              ? 'Seleccione al menos un consentimiento'
              : count === 1
                ? 'Diligenciar 1 consentimiento'
                : `Diligenciar ${count} consentimientos`
          }
          disabled={count === 0}
          onPress={() =>
            router.push({ pathname: '/(app)/consent/[code]', params: { code: sessionKey(selected) } })
          }
        />
      </View>
    </View>
  );
}

type Audience = 'adult' | 'minor';

const AUDIENCES: { value: Audience; label: string }[] = [
  { value: 'adult', label: 'Adultos' },
  { value: 'minor', label: 'Menores de edad' },
];

const styles = StyleSheet.create({
  screen: { flex: 1 },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#d7e1e1',
    backgroundColor: '#fff',
  },
  tabActive: { borderColor: '#2563eb', backgroundColor: '#2563eb' },
  tabLabel: { fontSize: 16, fontWeight: '700', color: '#12212b' },
  tabCount: { fontSize: 12, color: '#4e6870', marginTop: 2 },
  tabLabelActive: { color: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { fontSize: 14, color: '#dc2626', textAlign: 'center' },
  list: { padding: 20, gap: 12 },
  header: { gap: 10 },
  hint: { fontSize: 13, lineHeight: 19, color: '#4e6870' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d7e1e1',
    backgroundColor: '#fff',
  },
  cardSelected: { borderColor: '#2563eb', borderWidth: 2, backgroundColor: '#eef4ff' },
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#9fb4b4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkSelected: { borderColor: '#2563eb', backgroundColor: '#2563eb' },
  checkMark: { color: '#fff', fontWeight: '700', fontSize: 14 },
  cardText: { flex: 1 },
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
  footer: {
    padding: 16,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#d7e1e1',
    backgroundColor: '#fff',
  },
});
