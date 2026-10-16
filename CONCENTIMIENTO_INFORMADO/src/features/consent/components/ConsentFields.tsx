import { useRef } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { filterFor, sanitizeFieldValue } from '@/features/consent/services/fieldFilters';
import { MULTI_SEPARATOR, selectedOptions } from '@/features/consent/services/fieldRules';
import type { ConsentField } from '@/features/consent/types/consent';

type ConsentFieldsProps = {
  fields: ConsentField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  /** Whether a field must be filled right now; unrequired ones are labelled "(opcional)". */
  isRequired?: (field: ConsentField) => boolean;
  /**
   * A field (label + input) received focus. `offsetY` is its top edge in the
   * coordinate space of this component's parent — for a parent ScrollView,
   * that is directly usable as a `scrollTo` target.
   */
  onFieldFocus?: (key: string, offsetY: number) => void;
};

export function ConsentFields({
  fields,
  values,
  onChange,
  disabled,
  isRequired,
  onFieldFocus,
}: ConsentFieldsProps) {
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

  function toggleOption(field: ConsentField, option: string) {
    if (!field.multiple) {
      // Tapping the chosen option again clears it.
      onChange(field.key, values[field.key] === option ? '' : option);
      return;
    }
    const chosen = selectedOptions(values[field.key]);
    const next = chosen.includes(option)
      ? chosen.filter((o) => o !== option)
      : // Keep the template's order, not the tap order.
        (field.options ?? []).filter((o) => o === option || chosen.includes(o));
    onChange(field.key, next.join(MULTI_SEPARATOR));
  }

  return (
    <View style={styles.container} onLayout={handleContainerLayout}>
      {fields.map((field) => {
        const isReadOnly = Boolean(field.prefill);
        const filter = filterFor(field);
        const optional = isRequired ? !isRequired(field) : field.required === false;
        return (
          <View
            key={field.key}
            style={styles.field}
            onLayout={(event) => handleFieldLayout(field.key, event)}
          >
            <Text style={styles.label}>
              {field.label}
              {optional ? <Text style={styles.optional}> (opcional)</Text> : null}
              {field.multiple ? <Text style={styles.optional}> · puede marcar varias</Text> : null}
            </Text>

            {field.input === 'select' ? (
              <View style={styles.options}>
                {(field.options ?? []).map((option) => {
                  const active = selectedOptions(values[field.key]).includes(option);
                  return (
                    <Pressable
                      key={option}
                      accessibilityRole={field.multiple ? 'checkbox' : 'radio'}
                      accessibilityState={{ checked: active, disabled }}
                      disabled={disabled || isReadOnly}
                      onPress={() => toggleOption(field, option)}
                      style={({ pressed }) => [
                        styles.option,
                        active && styles.optionActive,
                        pressed && styles.optionPressed,
                      ]}
                    >
                      <Text style={[styles.optionMark, active && styles.optionMarkActive]}>
                        {active ? '✓' : field.multiple ? '☐' : '○'}
                      </Text>
                      <Text style={[styles.optionLabel, active && styles.optionLabelActive]}>
                        {option}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <TextInput
                style={[styles.input, isReadOnly && styles.inputReadOnly]}
                value={values[field.key] ?? ''}
                onChangeText={(text) => onChange(field.key, sanitizeFieldValue(field, text))}
                onFocus={() => handleFocus(field.key)}
                placeholder={field.placeholder ?? (filter === 'date' ? 'DD/MM/AAAA' : undefined)}
                keyboardType={filter === 'digits' || filter === 'date' ? 'number-pad' : 'default'}
                autoCapitalize={filter === 'name' ? 'words' : 'sentences'}
                autoCorrect={filter === null}
                maxLength={filter === 'date' ? 10 : undefined}
                editable={!disabled && !isReadOnly}
              />
            )}
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
  optional: { fontWeight: '400', color: '#7b8f95' },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fff',
  },
  inputReadOnly: { backgroundColor: '#eaf0f0', color: '#4e6870' },
  options: { gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionActive: { borderColor: '#2563eb', borderWidth: 2, backgroundColor: '#eef4ff' },
  optionPressed: { opacity: 0.8 },
  optionMark: { fontSize: 16, color: '#7b8f95', width: 18, textAlign: 'center' },
  optionMarkActive: { color: '#2563eb', fontWeight: '700' },
  optionLabel: { flex: 1, fontSize: 14, color: '#12212b' },
  optionLabelActive: { fontWeight: '600' },
});
