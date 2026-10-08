import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

/**
 * Password field with a "Mostrar / Ocultar" toggle, so a mistyped password can
 * be checked before sending. Text instead of an eye icon: no icon library, and
 * the word is clearer for staff of every age.
 */
export function PasswordInput(props: Omit<TextInputProps, 'secureTextEntry'>) {
  const [visible, setVisible] = useState(false);

  return (
    <View style={styles.row}>
      <TextInput
        {...props}
        style={[styles.input, props.style]}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={() => setVisible((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        hitSlop={8}
        style={styles.toggle}
      >
        <Text style={styles.toggleText}>{visible ? 'Ocultar' : 'Mostrar'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
  },
  input: { flex: 1, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 0 },
  toggle: { paddingHorizontal: 12, paddingVertical: 10 },
  toggleText: { color: '#1e5aa8', fontWeight: '600' },
});
