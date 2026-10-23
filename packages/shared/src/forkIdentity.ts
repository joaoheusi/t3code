/** Shared distribution identity. Upstream artifacts never contain the fork extensions. */
export const FORK_IDENTITY = {
  name: "J4 Code (Unofficial)",
  repository: "joaoheusi/t3code",
  upstreamCommit: "0e7346ccd9427c06161e222319e718e6bd70887f",
  version: "0.1.0-j4.14",
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
