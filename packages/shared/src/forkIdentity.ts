/** Shared distribution identity. Upstream artifacts never contain the fork extensions. */
export const FORK_IDENTITY = {
  name: "J4 Code (Unofficial)",
  repository: "joaoheusi/t3code",
  upstreamCommit: "f4f148eb670622a049ae6561d7795011e383fc43",
  version: "0.0.45-j4.2",
  /** Desktop OS identity, distinct from upstream so both apps install side by side. */
  desktop: {
    production: {
      scheme: "j4code",
      linuxDesktopEntryName: "dev.joaoheusi.J4Code.desktop",
      userDataDirectoryName: "j4code",
    },
    development: {
      scheme: "j4code-dev",
      linuxDesktopEntryName: "dev.joaoheusi.J4Code.Development.desktop",
      userDataDirectoryName: "j4code-dev",
    },
  },
} as const;

export function forkDesktopIdentity(isDevelopment: boolean) {
  return isDevelopment ? FORK_IDENTITY.desktop.development : FORK_IDENTITY.desktop.production;
}

/** Kept as a function so every installer must deliberately opt into an owned feed. */
export function forkUpdatesEnabled(): boolean {
  return false;
}
