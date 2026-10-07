/** Shared distribution identity. Upstream artifacts never contain the fork extensions. */
export const FORK_IDENTITY = {
  name: "J4 Code (Unofficial)",
  repository: "joaoheusi/t3code",
  upstreamCommit: "f4f148eb670622a049ae6561d7795011e383fc43",
  version: "0.0.45-j4.2",
} as const;

/** Kept as a function so every installer must deliberately opt into an owned feed. */
export function forkUpdatesEnabled(): boolean {
  return false;
}
