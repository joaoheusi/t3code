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

/** All selected PRs must allow the method the reader confirms. Rechecked in the write lane. */
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
