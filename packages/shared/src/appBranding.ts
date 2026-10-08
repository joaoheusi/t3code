/** Visual stage is separate from the updater channel; fork builds update manually. */
export function isNightlyAppVersion(version: string): boolean {
  return /^[^-+]+-(?:(?:nightly|preview)\.\d{8}\.\d+|j4\.\d+)$/.test(version);
}

export const J4_WORDMARK = {
  viewBox: "18.6 37 91.3 56.96",
  aspectRatio: 91.3 / 56.96,
  path: "M30.5 37H59V72.2C59 84.9 50.3 93.96 37.6 93.96C29.7 93.96 22.9 90.6 18.6 84.6L26.2 75.6C29 79.6 32.5 81.8 36.9 81.8C42.6 81.8 46 78.1 46 71.6V47.56H30.5Z M84.6 37H100.1V70.6H109.9V81.4H100.1V93H87.3V81.4H65.4V71.6Z M80.2 70.6H87.3V58.4Z",
} as const;
