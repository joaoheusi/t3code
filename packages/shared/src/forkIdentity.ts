/** Shared distribution identity. Upstream artifacts never contain the fork extensions. */
export const FORK_IDENTITY = {
  name: "J4 Code (Unofficial)",
  repository: "joaoheusi/t3code",
  upstreamCommit: "b707eeb052782cfd8b1ff0445f84b2aaf01da38b",
  version: "0.0.45-j4.7",
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
