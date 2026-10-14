import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestMergeMethod,
} from "@t3tools/contracts";

export const PULL_REQUEST_MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** The slice of a detail that decides which actions it offers. */
export type PullRequestActionableDetail = Pick<
  PullRequestDetail,
  "state" | "isDraft" | "mergeability" | "capabilities" | "viewerPermissions" | "mergeCapabilities"
>;

/**
 * The host says which strategies it offers at all; the repository narrows that to the ones it
 * actually allows.
 */
export function allowedPullRequestMergeMethods(
  detail: Pick<PullRequestActionableDetail, "capabilities" | "mergeCapabilities"> | null,
): ReadonlyArray<PullRequestMergeMethod> {
  return detail === null
    ? []
    : detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]);
}

/**
 * Two questions, both of which have to say yes: whether this host can do it at all, and whether
 * this account may. A reader with read access on someone else's project sees the pull request and
 * none of the buttons that would only ever be refused.
 */
function canPerformPullRequestAction(
  detail: Pick<PullRequestActionableDetail, "capabilities" | "viewerPermissions"> | null,
  action: PullRequestAction,
): boolean {
  return (
    detail !== null &&
    detail.capabilities.actions.includes(action) &&
    detail.viewerPermissions.actions.includes(action)
  );
}

export function isPullRequestConflicting(
  detail: Pick<PullRequestActionableDetail, "state" | "mergeability"> | null,
): boolean {
  return detail?.state === "open" && detail.mergeability === "conflicting";
}

/** The checks as one word. Failing outranks running: a red run is already worth acting on. */
export type PullRequestChecksState = "none" | "pending" | "failing" | "passing";

export function classifyPullRequestChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.status === "failure" || check.status === "cancelled")) {
    return "failing";
  }
  if (checks.some((check) => check.status === "pending" || check.status === "action-required")) {
    return "pending";
  }
  return "passing";
}

export type ThreadPanelPullRequestAction = "resolve" | "ready" | "fix" | "merge";

/**
 * Which single action the thread panel's compact pull request row offers, ranked by what
 * unblocks the merge next: conflicts stop everything, a draft is not up for review yet, failing
 * checks want fixing, and only a clean open pull request earns Merge. While checks run the slot
 * stays empty — the row shows their progress instead of an action that would race them.
 */
export function resolveThreadPanelPullRequestAction(
  detail: (PullRequestActionableDetail & Pick<PullRequestDetail, "checks">) | null,
): ThreadPanelPullRequestAction | null {
  if (detail === null || detail.state !== "open") return null;
  if (isPullRequestConflicting(detail)) return "resolve";
  if (detail.isDraft) {
    return canPerformPullRequestAction(detail, "ready") ? "ready" : null;
  }
  const checks = classifyPullRequestChecks(detail.checks);
  if (checks === "failing") return "fix";
  if (checks === "pending") return null;
  return canPerformPullRequestAction(detail, "merge") &&
    allowedPullRequestMergeMethods(detail).length > 0
    ? "merge"
    : null;
}

/** What decides whether a merge can start. Absent fields are unknown and never block. */
export interface PullRequestMergeState {
  readonly state: PullRequestDetail["state"];
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestDetail["mergeability"] | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
  /** Whether the host lets this account merge with at least one allowed method. */
  readonly canMerge?: boolean | undefined;
}

export function pullRequestDetailMergeState(detail: PullRequestDetail): PullRequestMergeState {
  return {
    state: detail.state,
    isDraft: detail.isDraft,
    mergeability: detail.mergeability,
    checksState: classifyPullRequestChecks(detail.checks),
    canMerge:
      canPerformPullRequestAction(detail, "merge") &&
      allowedPullRequestMergeMethods(detail).length > 0,
  };
}

/**
 * Why a merge would be refused, so menus can disable it before it is tried. Null when nothing
 * known blocks it. For a full detail this is null exactly when the thread panel offers Merge.
 * A synced thread snapshot also fits, minus permissions.
 */
export function pullRequestMergeBlocker(pullRequest: PullRequestMergeState): string | null {
  if (pullRequest.state === "merged") return "Already merged";
  if (pullRequest.state === "closed") return "Closed";
  if (pullRequest.mergeability === "conflicting") return "Has merge conflicts";
  if (pullRequest.isDraft) return "Still a draft";
  if (pullRequest.checksState === "failing") return "CI failing";
  if (pullRequest.checksState === "pending") return "Waiting for CI";
  if (pullRequest.canMerge === false) return "You can't merge this pull request";
  return null;
}

/**
 * Methods every selected PR allows, for one batch method choice. Empty when any selected PR
 * cannot merge right now or the repositories share no method. Rechecked in the write lane.
 */
export function quickActionMergeMethods(details: readonly PullRequestDetail[]) {
  if (
    details.length === 0 ||
    details.some((detail) => resolveThreadPanelPullRequestAction(detail) !== "merge")
  )
    return [];
  return allowedPullRequestMergeMethods(details[0]!).filter((method) =>
    details.every((detail) => allowedPullRequestMergeMethods(detail).includes(method)),
  );
}

/**
 * One PR's default method: a plain merge when the repository allows it, else its first allowed
 * method. Used when a batch shares no method, so it can still merge in one pass. Null when the
 * PR cannot merge right now. Rechecked in the write lane.
 */
export function quickActionMergeMethod(detail: PullRequestDetail): PullRequestMergeMethod | null {
  if (resolveThreadPanelPullRequestAction(detail) !== "merge") return null;
  const allowed = allowedPullRequestMergeMethods(detail);
  return allowed.includes("merge") ? "merge" : (allowed[0] ?? null);
}
