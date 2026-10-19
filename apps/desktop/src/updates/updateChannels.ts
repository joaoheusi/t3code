import type { DesktopUpdateChannel } from "@t3tools/contracts";
export { isNightlyAppVersion as isNightlyDesktopVersion } from "@t3tools/shared/appBranding";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
