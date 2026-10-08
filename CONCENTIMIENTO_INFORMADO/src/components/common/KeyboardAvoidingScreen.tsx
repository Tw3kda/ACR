import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Native-stack header heights, excluding the status bar. */
const HEADER_HEIGHT = Platform.select({ ios: 44, default: 56 });

type KeyboardAvoidingScreenProps = {
  children: ReactNode;
  /**
   * Whether a navigation header sits above this screen. KeyboardAvoidingView
   * measures its own frame relative to its parent but the keyboard in window
   * coordinates, so anything above the screen has to be declared as an offset
   * or the overlap is under-estimated by exactly that height.
   */
  hasHeader?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * Keeps inputs above the keyboard.
 *
 * `behavior="padding"` on both platforms, deliberately: KeyboardAvoidingView
 * pads by the measured overlap between its frame and the keyboard and
 * re-measures on layout changes, so on Android — where the window normally
 * resizes on its own — the overlap resolves to zero and nothing doubles up,
 * while on iOS (and on Android if the window does not resize) it pads exactly
 * the covered amount.
 */
export function KeyboardAvoidingScreen({ children, hasHeader = false, style }: KeyboardAvoidingScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      style={[styles.flex, style]}
      behavior="padding"
      keyboardVerticalOffset={hasHeader ? insets.top + HEADER_HEIGHT : 0}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
