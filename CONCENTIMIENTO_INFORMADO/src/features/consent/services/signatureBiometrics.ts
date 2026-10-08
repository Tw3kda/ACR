/**
 * Stroke biometrics for a captured signature — the `biometrics_json` block of
 * the audit log: every sampled point as (x, y, p, t).
 *
 * `react-native-signature-canvas` draws inside a WebView, and the signature_pad
 * build it ships records only x/y/time — no pressure. So instead of reading its
 * point groups we install our own PointerEvent listeners on the same canvas
 * through `injectedJavaScript`, which gives us `event.pressure` from an active
 * stylus alongside the coordinates.
 *
 * The listeners post a JSON object, and the library forwards any JSON message
 * it does not recognise to `onGetData` — that is the channel this rides on,
 * which is why the payload is tagged with `BIOMETRICS_MESSAGE_KEY`.
 */

/** One sample: position, pen force 0..1, ms since the first pen-down. */
export type BiometricPoint = { x: number; y: number; p: number; t: number };

export type BiometricStroke = { stroke_index: number; points: BiometricPoint[] };

export type SignatureBiometrics = {
  sampling_rate_hz: number;
  total_duration_ms: number;
  device_pressure_supported: boolean;
  strokes: BiometricStroke[];
};

/** Discriminator that separates our messages from signature_pad's own. */
const BIOMETRICS_MESSAGE_KEY = '__acr_biometrics';

export function emptyBiometrics(): SignatureBiometrics {
  return {
    sampling_rate_hz: 0,
    total_duration_ms: 0,
    device_pressure_supported: false,
    strokes: [],
  };
}

/** Total sampled points across every stroke — handy for logs and assertions. */
export function countBiometricPoints(biometrics: SignatureBiometrics | null): number {
  if (!biometrics) return 0;
  return biometrics.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
}

/**
 * Reads a WebView message. Returns null for anything that is not ours —
 * including signature_pad's own `getData()` array — so the caller can ignore it.
 */
export function parseBiometricsMessage(raw: string): SignatureBiometrics | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const payload = parsed[BIOMETRICS_MESSAGE_KEY] as SignatureBiometrics | undefined;
    if (!payload || !Array.isArray(payload.strokes)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Injected into the signature WebView once it has loaded. Written as ES5 in a
 * plain string because it is evaluated inside the WebView, not bundled.
 */
export const SIGNATURE_BIOMETRICS_SCRIPT = `
(function () {
  if (window.__acrBiometricsInstalled) return true;

  var MESSAGE_KEY = '${BIOMETRICS_MESSAGE_KEY}';
  var strokes = [];
  var current = null;
  var originTime = null;
  var pressureSeen = false;

  function now() {
    return (window.performance && window.performance.now)
      ? window.performance.now()
      : Date.now();
  }

  function reset() {
    strokes = [];
    current = null;
    originTime = null;
    pressureSeen = false;
  }

  function totalDuration() {
    var last = 0;
    for (var i = 0; i < strokes.length; i++) {
      var points = strokes[i].points;
      if (points.length) last = Math.max(last, points[points.length - 1].t);
    }
    return Math.round(last);
  }

  // Digitizer rate, so it measures time spent drawing: the gaps between
  // strokes are pauses, not slow sampling, and must not drag the figure down.
  function samplingRate() {
    var intervals = 0;
    var drawingMs = 0;
    for (var i = 0; i < strokes.length; i++) {
      var points = strokes[i].points;
      if (points.length < 2) continue;
      intervals += points.length - 1;
      drawingMs += points[points.length - 1].t - points[0].t;
    }
    if (!drawingMs) return 0;
    return Math.round((intervals / drawingMs) * 1000);
  }

  function post() {
    if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
    var payload = {};
    payload[MESSAGE_KEY] = {
      sampling_rate_hz: samplingRate(),
      total_duration_ms: totalDuration(),
      device_pressure_supported: pressureSeen,
      strokes: strokes
    };
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  function sample(event, rect) {
    // A finger or mouse reports either 0 or the 0.5 default; only a value
    // outside that pair proves the digitizer actually measures force.
    var pressure = typeof event.pressure === 'number' ? event.pressure : 0.5;
    if (event.pointerType === 'pen' && pressure > 0 && pressure !== 0.5) pressureSeen = true;

    return {
      x: round(event.clientX - rect.left, 1),
      y: round(event.clientY - rect.top, 1),
      p: round(pressure, 3),
      t: Math.round(now() - originTime)
    };
  }

  function install(canvas) {
    canvas.addEventListener('pointerdown', function (event) {
      if (originTime === null) originTime = now();
      current = { stroke_index: strokes.length, points: [] };
      strokes.push(current);
      current.points.push(sample(event, canvas.getBoundingClientRect()));
    }, true);

    canvas.addEventListener('pointermove', function (event) {
      if (!current) return;
      var rect = canvas.getBoundingClientRect();
      // Coalesced events recover the samples the browser batched into one
      // frame — that is where a 120Hz stylus rate actually shows up. The list
      // is empty on engines that do not fill it (and for synthetic events), so
      // the event itself is the fallback rather than dropping the sample.
      var events = (event.getCoalescedEvents && event.getCoalescedEvents()) || [];
      if (!events.length) events = [event];
      for (var i = 0; i < events.length; i++) current.points.push(sample(events[i], rect));
    }, true);

    function end() {
      if (!current) return;
      current = null;
      post();
    }

    canvas.addEventListener('pointerup', end, true);
    canvas.addEventListener('pointercancel', end, true);
    canvas.addEventListener('pointerleave', end, true);

    // The pad's "clear" button goes through the global signature_pad helpers,
    // so wrapping them keeps our buffer in step with what is on screen.
    ['clearSignature', 'erase'].forEach(function (name) {
      var original = window[name];
      if (typeof original !== 'function') return;
      window[name] = function () {
        reset();
        return original.apply(this, arguments);
      };
    });

    window.__acrBiometricsInstalled = true;
  }

  // The canvas is created by the pad's own bootstrap; wait for it.
  var attempts = 0;
  (function waitForCanvas() {
    var canvas = document.querySelector('canvas');
    if (canvas) return install(canvas);
    if (attempts++ > 50) return;
    setTimeout(waitForCanvas, 100);
  })();
})();
true;
`;
