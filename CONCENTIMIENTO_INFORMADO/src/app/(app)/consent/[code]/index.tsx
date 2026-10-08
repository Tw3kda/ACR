import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { Button } from "@/components/ui/Button";
import { SignaturePad } from "@/components/ui/SignaturePad";
import { ConsentDocumentBody } from "@/features/consent/components/ConsentDocument";
import { ConsentFields } from "@/features/consent/components/ConsentFields";
import { useConsentDraft } from "@/features/consent/store/consentDraftStore";
import type { DecisionChoice } from "@/features/consent/types/consent";

/** Slack in pixels: "the bottom" should not require a pixel-perfect scroll. */
const SCROLL_END_THRESHOLD = 24;

/** Where a focused field lands: this far below the top of the visible area. */
const FOCUSED_FIELD_TOP_MARGIN = 24;

/** Bottom padding of the form with the keyboard down. */
const BASE_BOTTOM_PADDING = 48;

export default function ConsentFillScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const {
    template,
    baseTemplate,
    decision,
    setDecision,
    values,
    signatures,
    isLoading,
    error,
    loadTemplate,
    setValue,
    setSignature,
    setBiometrics,
    markScrolledToBottom,
    isStageComplete,
  } = useConsentDraft();

  /**
   * `has_scrolled_to_bottom` in the audit log: evidence the whole document was
   * at least put in front of the patient. Latched on — scrolling back up does
   * not undo having reached the end.
   */
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } =
        event.nativeEvent;
      const reachedEnd =
        layoutMeasurement.height + contentOffset.y >=
        contentSize.height - SCROLL_END_THRESHOLD;
      if (reachedEnd) markScrolledToBottom();
    },
    [markScrolledToBottom],
  );

  useEffect(() => {
    if (code && template?.code !== code) {
      loadTemplate(code);
    }
  }, [code, template?.code, loadTemplate]);

  /**
   * Keyboard handling, in two parts.
   *
   * (a) While the keyboard is up, the scroll content gets extra bottom padding
   *     equal to the keyboard's height. This is what makes "move the whole
   *     form above the keyboard" possible: without it there is not enough
   *     content below the first field to scroll it to the top, the scroll
   *     clamps, and everything after it stays under the keyboard. It is the
   *     cross-platform equivalent of ScrollView's iOS-only
   *     `automaticallyAdjustKeyboardInsets`.
   *
   * (b) On focus, the focused field is scrolled to the top of the visible
   *     area, so the fields and signature slot after it are in view too. Done
   *     explicitly because on Android with edge-to-edge the window does not
   *     resize for the keyboard, so the native scroll-into-view never fires.
   *     It re-runs when the keyboard height arrives and when the padding from
   *     (a) has grown the content — the target is a content offset, so
   *     repeating it is idempotent and whichever runs last wins.
   */
  const scrollRef = useRef<ScrollView>(null);
  const focusedFieldY = useRef<number | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const scrollFocusedFieldIntoView = useCallback(() => {
    const y = focusedFieldY.current;
    if (y === null) return;
    scrollRef.current?.scrollTo({
      y: Math.max(y - FOCUSED_FIELD_TOP_MARGIN, 0),
      animated: true,
    });
  }, []);

  useEffect(() => {
    // iOS reports the frame before the animation ("will"); Android only after.
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const shown = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates.height);
      scrollFocusedFieldIntoView();
    });
    const hidden = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
      focusedFieldY.current = null;
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [scrollFocusedFieldIntoView]);

  const handleFieldFocus = useCallback(
    (_key: string, offsetY: number) => {
      focusedFieldY.current = offsetY;
      scrollFocusedFieldIntoView();
    },
    [scrollFocusedFieldIntoView],
  );

  if (isLoading || (!template && !error)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !template || !baseTemplate) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>
          {error ?? "No se encontró el consentimiento."}
        </Text>
      </View>
    );
  }

  const patientSignatures = template.signatures.filter(
    (slot) => slot.signer === "patient",
  );
  // Forms with an accept/decline step show the fields and signature only once
  // the patient has answered; the chosen text is part of what they sign.
  const awaitingDecision = Boolean(baseTemplate.decision) && !decision;

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[
        styles.container,
        { paddingBottom: BASE_BOTTOM_PADDING + keyboardHeight },
      ]}
      onScroll={handleScroll}
      scrollEventThrottle={100}
      // The keyboard padding just grew the content — now there is room to
      // put the focused field at the top.
      onContentSizeChange={scrollFocusedFieldIntoView}
      // Let a tap on the button land while the keyboard is up, instead of
      // the first tap only dismissing it. Dragging the list also dismisses.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {/* No document header while filling — it belongs to the rendered
          document, which the patient sees in the preview and the PDF. */}
      <Text style={styles.title}>{template.title}</Text>
      <ConsentDocumentBody blocks={baseTemplate.blocks} />

      {baseTemplate.decision ? (
        <View style={styles.decision}>
          {decision === null ? (
            // 1. The question, with both answers side by side.
            <>
              <Text style={styles.decisionPrompt}>
                {baseTemplate.decision.prompt}
              </Text>
              <View style={styles.decisionButtons}>
                {(["accept", "decline"] as const).map((choice) => (
                  <Pressable
                    key={choice}
                    accessibilityRole="button"
                    onPress={() => setDecision(choice)}
                    style={({ pressed }) => [
                      styles.choice,
                      choice === "accept"
                        ? styles.choiceAccept
                        : styles.choiceDecline,
                      pressed && styles.choicePressed,
                    ]}
                  >
                    <Text style={styles.choiceMark}>
                      {choice === "accept" ? "✓" : "✗"}
                    </Text>
                    <Text style={styles.choiceLabel}>
                      {baseTemplate.decision![choice].label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            // 2. The answer, impossible to miss, and the only way back is a
            //    deliberate "Cambiar respuesta".
            <>
              <DecisionBanner
                choice={decision}
                label={baseTemplate.decision[decision].label}
              />
              <ConsentDocumentBody
                blocks={baseTemplate.decision[decision].blocks}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  confirmChangeDecision(
                    Boolean(signatures[patientSignatures[0]?.key ?? ""]),
                    () => setDecision(null),
                  )
                }
                style={({ pressed }) => [
                  styles.changeButton,
                  pressed && styles.choicePressed,
                ]}
              >
                <Text style={styles.changeButtonText}>Cambiar respuesta</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}

      {awaitingDecision ? null : (
        <>
          <View style={styles.divider} />

          <ConsentFields
            fields={template.fields}
            values={values}
            onChange={setValue}
            onFieldFocus={handleFieldFocus}
          />

          {patientSignatures.map((slot) => (
            // Keyed by the answer: changing it clears the drawn signature too.
            <View
              key={`${slot.key}-${decision ?? "none"}`}
              style={styles.signatureSection}
            >
              <Text style={styles.label}>{slot.label}</Text>
              <SignaturePad
                label={slot.label}
                onChange={(dataUrl) => setSignature(slot.key, dataUrl)}
                onBiometrics={(captured) => setBiometrics(slot.key, captured)}
              />
            </View>
          ))}

          <Button
            label="Revisar documento"
            onPress={() =>
              router.push({
                pathname: "/(app)/consent/[code]/preview",
                params: { code },
              })
            }
            disabled={!isStageComplete("patient")}
          />
        </>
      )}
    </ScrollView>
  );
}

/** Big, coloured statement of the patient's answer — green accept, red decline. */
function DecisionBanner({
  choice,
  label,
}: {
  choice: DecisionChoice;
  label: string;
}) {
  const accepted = choice === "accept";
  return (
    <View
      accessibilityRole="summary"
      style={[
        styles.banner,
        accepted ? styles.bannerAccept : styles.bannerDecline,
      ]}
    >
      <Text style={styles.bannerMark}>{accepted ? "✓" : "✗"}</Text>
      <View style={styles.bannerTextBox}>
        <Text style={styles.bannerCaption}>Su respuesta:</Text>
        <Text style={styles.bannerLabel}>{label.toUpperCase()}</Text>
      </View>
    </View>
  );
}

/** Going back to the question erases the patient's signature, so ask first. */
function confirmChangeDecision(hasSignature: boolean, change: () => void) {
  if (!hasSignature) {
    change();
    return;
  }
  const message =
    "Si cambia la respuesta, la firma se borrará y deberá firmar de nuevo.";
  if (Platform.OS === "web") {
    if (globalThis.confirm?.(message)) change();
    return;
  }
  Alert.alert("Cambiar respuesta", message, [
    { text: "Cancelar", style: "cancel" },
    { text: "Cambiar", style: "destructive", onPress: change },
  ]);
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: { fontSize: 18, fontWeight: "700", color: "#12212b" },
  divider: { height: 1, backgroundColor: "#d7e1e1", marginVertical: 4 },
  label: { fontSize: 13, fontWeight: "600", color: "#4e6870" },
  signatureSection: { gap: 8 },
  error: { fontSize: 14, color: "#dc2626", textAlign: "center" },
  decision: { gap: 12, paddingTop: 8 },
  decisionPrompt: {
    fontSize: 18,
    fontWeight: "700",
    color: "#12212b",
    textAlign: "center",
  },
  decisionButtons: { flexDirection: "row", gap: 16 },
  choice: {
    flex: 1,
    minHeight: 88,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    gap: 4,
  },
  choiceAccept: { backgroundColor: "#1f7a52" },
  choiceDecline: { backgroundColor: "#b42318" },
  choicePressed: { opacity: 0.8 },
  choiceMark: { fontSize: 26, color: "#fff", fontWeight: "700" },
  choiceLabel: { fontSize: 20, fontWeight: "700", color: "#fff" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 12,
    borderWidth: 3,
    padding: 16,
  },
  bannerAccept: { borderColor: "#1f7a52", backgroundColor: "#e2f5ec" },
  bannerDecline: { borderColor: "#b42318", backgroundColor: "#fdecea" },
  bannerMark: { fontSize: 36, fontWeight: "700", color: "#12212b" },
  bannerTextBox: { flex: 1 },
  bannerCaption: { fontSize: 13, color: "#4e6870" },
  bannerLabel: { fontSize: 24, fontWeight: "800", color: "#12212b" },
  changeButton: {
    alignSelf: "flex-start",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#4e6870",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  changeButtonText: { fontSize: 15, fontWeight: "600", color: "#12212b" },
});
