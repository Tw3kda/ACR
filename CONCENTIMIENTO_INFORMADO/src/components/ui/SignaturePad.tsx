import { useRef, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import SignatureScreen, { type SignatureViewRef } from 'react-native-signature-canvas';

import {
  SIGNATURE_BIOMETRICS_SCRIPT,
  countBiometricPoints,
  emptyBiometrics,
  parseBiometricsMessage,
  type SignatureBiometrics,
} from '@/features/consent/services/signatureBiometrics';

type SignaturePadProps = {
  /** Shown as the modal's title, e.g. "Firma del paciente". */
  label?: string;
  onChange: (signatureDataUrl: string | null) => void;
  /**
   * Fires with the full (x, y, p, t) capture when a signature is confirmed —
   * the `biometrics_json` block of the audit log. Optional: a pad used
   * somewhere that does not feed the log can ignore it.
   */
  onBiometrics?: (biometrics: SignatureBiometrics) => void;
};

/**
 * Inline slot in the form. Tapping it opens the signing surface full-screen.
 *
 * The canvas is a WebView, and a WebView inside a ScrollView fights the
 * ScrollView for every touch: the first pen-down is claimed by the scroll
 * gesture recogniser before the page sees it, so a stylus scrolls the form
 * instead of drawing (while a hovering pen, which sends no touch, "works").
 * Toggling `scrollEnabled` on stroke begin/end — the usual workaround — still
 * loses that first event. Putting the canvas in a Modal takes the ScrollView
 * out of the hierarchy entirely, and gives the signer the whole screen.
 */
export function SignaturePad({ label = 'Firma', onChange, onBiometrics }: SignaturePadProps) {
  const [signature, setSignature] = useState<string | null>(null);
  const [pointCount, setPointCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  function handleConfirm(dataUrl: string, biometrics: SignatureBiometrics) {
    setSignature(dataUrl);
    setPointCount(countBiometricPoints(biometrics));
    onChange(dataUrl);
    onBiometrics?.(biometrics);
    setIsOpen(false);
  }

  function handleClear() {
    setSignature(null);
    setPointCount(0);
    onChange(null);
    onBiometrics?.(emptyBiometrics());
  }

  return (
    <View>
      <Pressable
        onPress={() => setIsOpen(true)}
        style={({ pressed }) => [styles.slot, signature && styles.slotSigned, pressed && styles.slotPressed]}
        accessibilityRole="button"
        accessibilityLabel={signature ? `${label}: firmada. Toque para firmar de nuevo` : `${label}: toque para firmar`}
      >
        {signature ? (
          <View style={styles.slotImageFrame}>
            <Image source={{ uri: signature }} style={styles.slotImage} resizeMode="contain" />
          </View>
        ) : (
          <View style={styles.slotEmpty}>
            <Text style={styles.slotEmptyMark}>✎</Text>
            <Text style={styles.slotEmptyLabel}>Toque para firmar</Text>
          </View>
        )}
      </Pressable>

      <View style={styles.actions}>
        <Text style={styles.status}>
          {signature ? `Firma capturada · ${pointCount} puntos` : 'Sin firmar'}
        </Text>
        {signature ? (
          <Pressable onPress={handleClear} hitSlop={8}>
            <Text style={styles.clearLabel}>Limpiar firma</Text>
          </Pressable>
        ) : null}
      </View>

      {isOpen ? (
        <SignatureModal
          title={label}
          onCancel={() => setIsOpen(false)}
          onConfirm={handleConfirm}
        />
      ) : null}
    </View>
  );
}

type SignatureModalProps = {
  title: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string, biometrics: SignatureBiometrics) => void;
};

/**
 * Mounted only while open, so each signing starts on a fresh canvas and a
 * cancelled re-sign leaves the previous signature untouched in the parent.
 */
function SignatureModal({ title, onCancel, onConfirm }: SignatureModalProps) {
  const ref = useRef<SignatureViewRef>(null);
  // The injected script posts the capture after every stroke; keep the latest
  // and hand it over only on confirm, so a cancelled signing logs nothing.
  const biometricsRef = useRef<SignatureBiometrics>(emptyBiometrics());
  const [hasStrokes, setHasStrokes] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  function handleGetData(raw: string) {
    const biometrics = parseBiometricsMessage(raw);
    if (biometrics) biometricsRef.current = biometrics;
  }

  function handleClear() {
    ref.current?.clearSignature();
    biometricsRef.current = emptyBiometrics();
    setHasStrokes(false);
    setHint(null);
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent={false}
      onRequestClose={onCancel}
    >
      {/* A Modal lives in its own native view tree; on iOS the root provider's
          insets do not reach it, so it carries its own. */}
      <SafeAreaProvider>
      <SafeAreaView style={styles.modal} edges={['top', 'bottom']}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalHint}>Firme dentro del recuadro con el lápiz o el dedo.</Text>
        </View>

        <View style={styles.canvasFrame}>
          <SignatureScreen
            ref={ref}
            onOK={(dataUrl) => onConfirm(dataUrl, biometricsRef.current)}
            onEmpty={() => setHint('Dibuje su firma antes de confirmar.')}
            onBegin={() => {
              setHasStrokes(true);
              setHint(null);
            }}
            onGetData={handleGetData}
            autoClear={false}
            // Export only the ink's bounding box. The signing surface stays
            // full-screen; the resulting image is cropped so it renders large
            // in the slot and in the PDF instead of as a small mark in a big
            // white rectangle.
            trimWhitespace
            descriptionText=""
            webStyle={webStyle}
            webviewProps={{ injectedJavaScript: SIGNATURE_BIOMETRICS_SCRIPT }}
          />
        </View>

        <View style={styles.modalFooter}>
          {hint ? <Text style={styles.modalHintWarning}>{hint}</Text> : null}
          <View style={styles.modalButtons}>
            <Pressable onPress={onCancel} style={styles.secondaryButton} hitSlop={6}>
              <Text style={styles.secondaryButtonLabel}>Cancelar</Text>
            </Pressable>
            <Pressable
              onPress={handleClear}
              style={styles.secondaryButton}
              hitSlop={6}
              disabled={!hasStrokes}
            >
              <Text style={[styles.secondaryButtonLabel, !hasStrokes && styles.disabledLabel]}>
                Limpiar
              </Text>
            </Pressable>
            <Pressable
              onPress={() => ref.current?.readSignature()}
              style={({ pressed }) => [
                styles.primaryButton,
                !hasStrokes && styles.primaryButtonDisabled,
                pressed && styles.primaryButtonPressed,
              ]}
              disabled={!hasStrokes}
            >
              <Text style={styles.primaryButtonLabel}>Confirmar firma</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

/**
 * The pad's stylesheet centres a fixed 700×400 box, insets the drawing body
 * by 20px, reserves 60px for its own footer, and on tablets adds a 10% margin
 * all round. Every one of those shrinks the signing area, so all are overridden
 * to let the canvas fill the WebView edge to edge.
 */
const webStyle = `
  html, body { margin: 0; padding: 0; background-color: #fff; overflow: hidden; }
  .m-signature-pad {
    position: absolute !important;
    top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
    width: auto !important; height: auto !important; margin: 0 !important;
    box-shadow: none; border: none;
  }
  .m-signature-pad:before, .m-signature-pad:after { display: none; }
  .m-signature-pad--body {
    left: 0 !important; right: 0 !important; top: 0 !important; bottom: 0 !important;
    border: none;
  }
  .m-signature-pad--body canvas { border-radius: 0; box-shadow: none; }
  .m-signature-pad--footer { display: none; margin: 0; }
`;

const TEAL = '#0e7a82';
const INK = '#12212b';
const MUTED = '#4e6870';
const LINE = '#cbd5e1';

const styles = StyleSheet.create({
  slot: {
    height: 120,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: LINE,
    borderStyle: 'dashed',
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  slotSigned: { borderStyle: 'solid', borderColor: TEAL },
  slotPressed: { opacity: 0.7 },
  // The trimmed image hugs the ink, so a little breathing room keeps it off
  // the border.
  slotImageFrame: { flex: 1, padding: 10 },
  slotImage: { width: '100%', height: '100%' },
  slotEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  slotEmptyMark: { fontSize: 24, color: MUTED },
  slotEmptyLabel: { fontSize: 14, fontWeight: '600', color: TEAL },

  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  clearLabel: { color: TEAL, fontWeight: '600', fontSize: 13 },
  status: { color: MUTED, fontSize: 13 },

  modal: { flex: 1, backgroundColor: '#f4f6f6' },
  modalHeader: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, gap: 4 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: INK },
  modalHint: { fontSize: 14, color: MUTED },

  canvasFrame: {
    flex: 1,
    marginHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },

  modalFooter: { padding: 16, gap: 10 },
  modalHintWarning: { fontSize: 13, color: '#9c5e1c', textAlign: 'center' },
  modalButtons: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  secondaryButton: { paddingVertical: 12, paddingHorizontal: 8 },
  secondaryButtonLabel: { color: TEAL, fontWeight: '600', fontSize: 15 },
  disabledLabel: { color: '#9fb4b4' },
  primaryButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: TEAL,
    alignItems: 'center',
  },
  primaryButtonDisabled: { backgroundColor: '#9fc9cc' },
  primaryButtonPressed: { opacity: 0.8 },
  primaryButtonLabel: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
