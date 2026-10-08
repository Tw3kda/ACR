import { useRef } from 'react';
import { StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';

import { filterFor, sanitizeFieldValue } from '@/features/consent/services/fieldFilters';
import type { ConsentField } from '@/features/consent/types/consent';

type ConsentFieldsProps = {
  fields: ConsentField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  /**
   * A field (label + input) received focus. `offsetY` is its top edge in the
   * coordinate space of this component's parent — for a parent ScrollView,
   * that is directly usable as a `scrollTo` target.
   */
  onFieldFocus?: (key: string, offsetY: number) => void;
};

export function ConsentFields({ fields, values, onChange, disabled, onFieldFocus }: ConsentFieldsProps) {
  // Layout positions are kept in refs: they only matter at focus time and
  // must not trigger re-renders while the user types.
  const containerY = useRef(0);
  const fieldYs = useRef<Record<string, number>>({});

  function handleContainerLayout(event: LayoutChangeEvent) {
    containerY.current = event.nativeEvent.layout.y;
  }

  function handleFieldLayout(key: string, event: LayoutChangeEvent) {
    fieldYs.current[key] = event.nativeEvent.layout.y;
  }

  function handleFocus(key: string) {
    onFieldFocus?.(key, containerY.current + (fieldYs.current[key] ?? 0));
  }

  return (
    <View style={styles.container} onLayout={handleContainerLayout}>
      {fields.map((field) => {
        const isReadOnly = Boolean(field.prefill);
        const filter = filterFor(field);
        return (
          <View
            key={field.key}
            style={styles.field}
            onLayout={(event) => handleFieldLayout(field.key, event)}
          >
            <Text style={styles.label}>{field.label}</Text>
            <TextInput
              style={[styles.input, isReadOnly && styles.inputReadOnly]}
              value={values[field.key] ?? ''}
              onChangeText={(text) => onChange(field.key, sanitizeFieldValue(field, text))}
              onFocus={() => handleFocus(field.key)}
              placeholder={field.placeholder}
              keyboardType={filter === 'digits' ? 'number-pad' : 'default'}
              autoCapitalize={filter === 'name' ? 'words' : 'sentences'}
              autoCorrect={filter === null}
              editable={!disabled && !isReadOnly}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', color: '#4e6870' },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  inputReadOnly: { backgroundColor: '#eaf0f0', color: '#4e6870' },
});
