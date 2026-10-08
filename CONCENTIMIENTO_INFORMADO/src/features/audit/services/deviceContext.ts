import Constants from 'expo-constants';
import { Dimensions, PixelRatio, Platform } from 'react-native';

import type { ConsentAuditDeviceContext } from '@/features/audit/types/auditLog';

/**
 * The `device_context` block of the audit log.
 *
 * Everything comes from `Platform.constants` and `expo-constants` rather than
 * `expo-device`, so no extra native module is needed. `Platform.constants` is
 * typed as a platform union, so the fields are read through a loose record —
 * the keys differ per platform and are simply absent on web.
 */

type PlatformConstants = {
  Brand?: string;
  Manufacturer?: string;
  Model?: string;
  Release?: string;
  systemName?: string;
  osVersion?: string;
};

function platformConstants(): PlatformConstants {
  return (Platform.constants ?? {}) as PlatformConstants;
}

/** Physical pixels, the way a device's spec sheet quotes them. */
function screenResolution(): string {
  const { width, height } = Dimensions.get('screen');
  const scale = PixelRatio.get();
  return `${Math.round(width * scale)}x${Math.round(height * scale)}`;
}

function osName(): string {
  if (Platform.OS === 'android') return 'Android';
  if (Platform.OS === 'ios') return 'iOS';
  return Platform.OS;
}

function osVersion(): string {
  const constants = platformConstants();
  // Android reports the marketing release ("14"); iOS reports osVersion.
  return String(constants.Release ?? constants.osVersion ?? Platform.Version ?? 'unknown');
}

/**
 * @param when The signing instant. The offset is read from that date rather
 * than from "now" so a region with daylight saving stamps the offset that was
 * actually in force when the document was printed.
 */
export function collectDeviceContext(when: Date = new Date()): ConsentAuditDeviceContext {
  const constants = platformConstants();

  return {
    device_brand: constants.Brand ?? constants.Manufacturer ?? Platform.OS,
    device_model: constants.Model ?? Constants.deviceName ?? 'unknown',
    os_name: osName(),
    os_version: osVersion(),
    app_version: Constants.expoConfig?.version ?? 'unknown',
    expo_runtime_version:
      Constants.expoRuntimeVersion ?? Constants.expoConfig?.runtimeVersion?.toString() ?? 'unknown',
    screen_resolution: screenResolution(),
    // getTimezoneOffset() is minutes to add to local time to reach UTC, i.e.
    // the opposite sign of how offsets are normally written (UTC-5 → 300).
    utc_offset_minutes: -when.getTimezoneOffset(),
    // Filled in by the gateway — see the note on the type.
    ip_address: null,
  };
}
