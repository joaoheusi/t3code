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

/**
 * The checks that gate a merge: the required ones where the host marks any check, else all of
 * them. GitHub merges past a failing optional check, so the menus do too. Hosts that never mark
 * checks fall back to every check, the safe reading.
 */
function classifyMergeGatingChecks(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState {
  return classifyPullRequestChecks(
    checks.some((check) => check.required !== undefined)
      ? checks.filter((check) => check.required === true)
      : checks,
  );
}

/** What decides whether a merge can start. Absent fields are unknown and never block. */
export interface PullRequestMergeState {
  readonly state: PullRequestDetail["state"];
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestDetail["mergeability"] | undefined;
  /** The checks that gate the merge, from `classifyMergeGatingChecks`. */
  readonly checksState?: PullRequestChecksState | null | undefined;
  /** Whether the host lets this account merge with at least one allowed method. */
  readonly canMerge?: boolean | undefined;
  /** Absent where the host does not say, which is not the same as off. */
  readonly autoMergeEnabled?: boolean | undefined;
  /** Whether the host lets this account arm auto-merge with at least one allowed method. */
  readonly canEnableAutoMerge?: boolean | undefined;
}

export function pullRequestDetailMergeState(detail: PullRequestDetail): PullRequestMergeState {
  const hasMethod = allowedPullRequestMergeMethods(detail).length > 0;
  return {
    state: detail.state,
    isDraft: detail.isDraft,
    mergeability: detail.mergeability,
    checksState: classifyMergeGatingChecks(detail.checks),
    canMerge: canPerformPullRequestAction(detail, "merge") && hasMethod,
    autoMergeEnabled: detail.autoMergeEnabled,
    canEnableAutoMerge: canPerformPullRequestAction(detail, "enable-auto-merge") && hasMethod,
  };
}

/**
 * The merge state a synced thread snapshot can vouch for. Its checks state covers every check,
 * not the required ones, so it never blocks a merge; fresh details decide that.
 */
export function pullRequestSnapshotMergeState(
  snapshot: Pick<PullRequestMergeState, "state" | "isDraft" | "mergeability">,
): PullRequestMergeState {
  return { state: snapshot.state, isDraft: snapshot.isDraft, mergeability: snapshot.mergeability };
}

/** Why a merge would be refused, so menus can disable it before it is tried. Null when nothing known blocks it. */
export function pullRequestMergeBlocker(pullRequest: PullRequestMergeState): string | null {
  if (pullRequest.state === "merged") return "Already merged";
  if (pullRequest.state === "closed") return "Closed";
  if (pullRequest.mergeability === "conflicting") return "Has merge conflicts";
  if (pullRequest.isDraft) return "Still a draft";
  if (pullRequest.autoMergeEnabled) return "Auto-merge is on";
  if (pullRequest.checksState === "failing") return "CI failing";
  if (pullRequest.checksState === "pending") return "Waiting for CI";
  if (pullRequest.canMerge === false) return "You can't merge this pull request";
  return null;
}

/** How the merge quick action starts a PR: merge it now, or arm auto-merge while CI runs. */
export type QuickActionMergeKind = "merge" | "auto-merge";

/**
 * Merge when nothing blocks it. While only required checks are still running, arm the host's
 * auto-merge instead, so the PR merges when they pass. Null when neither can start.
 */
export function quickActionMergeKind(
  pullRequest: PullRequestMergeState,
): QuickActionMergeKind | null {
  if (pullRequestMergeBlocker(pullRequest) === null) return "merge";
  return pullRequest.checksState === "pending" &&
    pullRequest.autoMergeEnabled === false &&
    pullRequest.canEnableAutoMerge === true &&
    pullRequestMergeBlocker({ ...pullRequest, checksState: null, canMerge: undefined }) === null
    ? "auto-merge"
    : null;
}

/**
 * Methods every selected PR allows, for one batch method choice. Empty when any selected PR
 * cannot start right now or the repositories share no method. Rechecked in the write lane.
 */
export function quickActionMergeMethods(details: readonly PullRequestDetail[]) {
  if (
    details.length === 0 ||
    details.some((detail) => quickActionMergeKind(pullRequestDetailMergeState(detail)) === null)
  )
    return [];
  return allowedPullRequestMergeMethods(details[0]!).filter((method) =>
    details.every((detail) => allowedPullRequestMergeMethods(detail).includes(method)),
  );
}

/**
 * One PR's default method: a plain merge when the repository allows it, else its first allowed
 * method. Used when a batch shares no method, so it can still merge in one pass. Null when the
 * PR cannot start right now. Rechecked in the write lane.
 */
export function quickActionMergeMethod(detail: PullRequestDetail): PullRequestMergeMethod | null {
  if (quickActionMergeKind(pullRequestDetailMergeState(detail)) === null) return null;
  const allowed = allowedPullRequestMergeMethods(detail);
  return allowed.includes("merge") ? "merge" : (allowed[0] ?? null);
}

export interface QuickActionMergePlan<Reference> {
  readonly reference: Reference;
  readonly kind: QuickActionMergeKind;
  readonly method: PullRequestMergeMethod;
}

/**
 * The `runAction` input for one planned PR. The write lane rechecks the fresh detail, and refuses
 * when the PR no longer starts the same way, such as CI finishing after auto-merge was chosen.
 */
export function quickActionMergeActionInput<Reference extends object>(
  plan: QuickActionMergePlan<Reference>,
) {
  return {
    ...plan.reference,
    action: plan.kind === "merge" ? ("merge" as const) : ("enable-auto-merge" as const),
    resolveMergeMethod: (detail: PullRequestDetail) => {
      if (
        quickActionMergeKind(pullRequestDetailMergeState(detail)) !== plan.kind ||
        !allowedPullRequestMergeMethods(detail).includes(plan.method)
      )
        throw new Error(
          "This pull request's status or allowed merge methods changed. Review it again.",
        );
      return plan.method;
    },
  };
}

/** "Squash and merge", or "Auto-merge · Squash and merge" when the host merges it later. */
export function quickActionMergePlanLabel(
  plan: Pick<QuickActionMergePlan<unknown>, "kind" | "method">,
): string {
  const method = PULL_REQUEST_MERGE_METHOD_LABELS[plan.method];
  return plan.kind === "merge" ? method : `Auto-merge · ${method}`;
}

/** "Merged 1 of 2 pull requests", or with auto-merge in the batch, "Merged 1, auto-merge on for 1 of 2 pull requests". */
export function quickActionMergeResultTitle(
  plans: readonly QuickActionMergePlan<unknown>[],
  succeeded: readonly QuickActionMergePlan<unknown>[],
): string {
  const noun = plans.length === 1 ? "pull request" : "pull requests";
  const armed = succeeded.filter((plan) => plan.kind === "auto-merge").length;
  const merged = succeeded.length - armed;
  return plans.some((plan) => plan.kind === "auto-merge")
    ? `Merged ${merged}, auto-merge on for ${armed} of ${plans.length} ${noun}`
    : `Merged ${merged} of ${plans.length} ${noun}`;
}

/** "Merge 2 pull requests now", or "Merge 1 now, auto-merge 1 when CI passes". */
export function quickActionMergePlanSummary(
  plans: readonly Pick<QuickActionMergePlan<unknown>, "kind">[],
): string {
  const armed = plans.filter((plan) => plan.kind === "auto-merge").length;
  const merged = plans.length - armed;
  if (armed === 0) return `Merge ${merged} pull request${merged === 1 ? "" : "s"} now`;
  if (merged === 0) return `Auto-merge ${armed} when CI passes`;
  return `Merge ${merged} now, auto-merge ${armed} when CI passes`;
}
