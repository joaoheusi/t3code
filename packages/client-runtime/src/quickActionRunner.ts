import * as DateTime from "effect/DateTime";
import type {
  ActionContextInput,
  ActionContextResult,
  EnvironmentId,
  ProjectId,
  PullRequestActivity,
  PullRequestBaseComparison,
  PullRequestDetail,
  PullRequestMergeability,
  PullRequestRef,
  QuickAction,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import {
  BASE_UPDATE_STARTER_IDS,
  QUICK_ACTION_STARTER_IDS,
  quickActionRequirements,
  renderQuickAction,
  templateVariables,
  type QuickActionVariable,
} from "@t3tools/shared/quickActions";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { classifyPullRequestChecks } from "./pullRequestActions.ts";

/** Where an action runs: the composer's environment, project, and saved thread, if any. */
export interface QuickActionScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly thread: EnvironmentThreadShell | null;
}

export interface QuickActionChoice {
  readonly bindingId?: string;
  readonly pullRequest?: Pick<ThreadPullRequestLink, "host" | "repository" | "number">;
}

/** One concrete way to run an action. `label` names the PR or repository it targets. */
export interface QuickActionVariant {
  readonly key: string;
  readonly label: string | null;
  readonly choice: QuickActionChoice;
  readonly snapshot?: ThreadPullRequestLink["snapshot"];
  /** Freshly loaded CI, conflict, base, and review thread state, which outranks the snapshot. */
  readonly fresh?: PullRequestKnownState;
}

/** PR state a client already loaded, beyond what the snapshot says. */
export type PullRequestKnownState = Pick<
  PullRequestSignalState,
  "checks" | "mergeability" | "baseComparison" | "behindBy" | "reviewThreads"
>;

/** Keys fresh PR states for `quickActionTargets`. */
export const pullRequestTargetKey = (
  pullRequest: Pick<ThreadPullRequestLink, "host" | "repository" | "number">,
) => `${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`;

export type QuickActionTargets =
  | { readonly kind: "ready"; readonly variants: readonly QuickActionVariant[] }
  | { readonly kind: "unavailable"; readonly reason: string };

const openPullRequests = (thread: EnvironmentThreadShell | null) =>
  visibleThreadPullRequests(thread?.pullRequests ?? []).filter(
    (link) => link.snapshot === null || link.snapshot.state === "open",
  );

/**
 * Expands an action into the PRs and repositories its template needs. Several
 * candidates become several variants so nothing is guessed on the user's behalf.
 * `fresh` holds PR states the client already loaded, keyed by `pullRequestTargetKey`.
 */
export function quickActionTargets(
  action: QuickActionShape,
  scope: QuickActionScope,
  fresh?: ReadonlyMap<string, PullRequestKnownState>,
): QuickActionTargets {
  const needs = quickActionRequirements(action.template);
  if (needs.host && scope.projectId === null)
    return { kind: "unavailable", reason: "Needs a project" };
  if (needs.thread && scope.thread === null)
    return { kind: "unavailable", reason: "Available after the first message" };
  const bindings = scope.thread?.workspace?.bindings ?? [];
  const multiRepo = bindings.length > 1;
  const pullRequests = needs.pullRequest ? openPullRequests(scope.thread) : [];
  if (needs.pullRequest && pullRequests.length === 0)
    return { kind: "unavailable", reason: "Link an open pull request first" };

  const prOptions: ReadonlyArray<ThreadPullRequestLink | undefined> = needs.pullRequest
    ? pullRequests
    : [undefined];
  const variants: QuickActionVariant[] = [];
  for (const link of prOptions) {
    const prLabel = link
      ? multiRepo || pullRequests.length > 1
        ? `${link.repository.split("/").at(-1)} #${link.number}`
        : `#${link.number}`
      : null;
    const known = link ? fresh?.get(pullRequestTargetKey(link)) : undefined;
    const boundTo = link?.bindingId;
    const bindingOptions =
      needs.repository && multiRepo && boundTo === undefined
        ? bindings.map((binding) => binding.id)
        : [boundTo];
    for (const bindingId of bindingOptions) {
      const bindingLabel =
        bindingId && boundTo === undefined
          ? (bindings.find((binding) => binding.id === bindingId)?.label ?? null)
          : null;
      variants.push({
        key: [link ? `${link.host}/${link.repository}#${link.number}` : "", bindingId ?? ""].join(
          "|",
        ),
        label: [bindingLabel, prLabel].filter(Boolean).join(" · ") || null,
        ...(link ? { snapshot: link.snapshot } : {}),
        ...(known ? { fresh: known } : {}),
        choice: {
          ...(bindingId ? { bindingId } : {}),
          ...(link
            ? { pullRequest: { host: link.host, repository: link.repository, number: link.number } }
            : {}),
        },
      });
    }
  }
  const applicable = variants.filter(
    (variant) => quickActionTargetNeedsAction(action, variant) !== false,
  );
  if (applicable.length === 0) {
    const signals = quickActionSignals(action);
    // "No failing CI checks" is true while CI runs, but says nothing useful.
    if (
      signals.includes("ci") &&
      variants.some((variant) => knownState(variant).checks === "pending")
    )
      return { kind: "unavailable", reason: "CI running, nothing failing yet" };
    const reasons = [
      ...(signals.includes("ci") ? ["failing CI checks"] : []),
      ...(signals.includes("conflicts") ? ["merge conflicts"] : []),
      ...(signals.includes("reviewThreads") ? ["unresolved review threads"] : []),
    ];
    return {
      kind: "unavailable",
      reason: reasons.length
        ? `No ${reasons.join(" or ")}`
        : signals.includes("base")
          ? "Already up to date with base"
          : "Nothing to do",
    };
  }
  return { kind: "ready", variants: applicable };
}

/** An action as the target helpers see it. Callers probing a template alone omit the ID. */
type QuickActionShape = Pick<QuickAction, "template"> & { readonly id?: string };

/** A PR state an action reports in menus; each action shows only the states it acts on. */
export type QuickActionSignal = "ci" | "conflicts" | "reviewThreads" | "base";

/**
 * CI for `{{ci.failures}}`, conflicts for `{{pr.conflicts}}`, threads for `{{pr.reviewThreads}}`.
 * The review threads and base update starters keep templates older clients can render, so
 * they are recognized by their stable IDs.
 */
export function quickActionSignals(action: QuickActionShape): QuickActionSignal[] {
  const used = templateVariables(action.template);
  return [
    ...(used.includes("ci.failures") ? (["ci"] as const) : []),
    ...(used.includes("pr.conflicts") ? (["conflicts"] as const) : []),
    ...(used.includes("pr.reviewThreads") ||
    action.id === QUICK_ACTION_STARTER_IDS.addressReviewThreads
      ? (["reviewThreads"] as const)
      : []),
    ...(action.id !== undefined && BASE_UPDATE_STARTER_IDS.has(action.id)
      ? (["base"] as const)
      : []),
  ];
}

/** What a PR is known to look like; absent fields are unknown or still loading. */
export interface PullRequestSignalState {
  readonly checks?: "none" | "pending" | "failing" | "passing" | null | undefined;
  readonly mergeability?: PullRequestMergeability | undefined;
  readonly baseComparison?: PullRequestBaseComparison | undefined;
  readonly behindBy?: number | undefined;
  readonly reviewThreads?:
    | { readonly unresolved: number; readonly truncated: boolean }
    | null
    | undefined;
}

export interface PullRequestSignalStatus {
  readonly signal: QuickActionSignal;
  readonly label: string;
  /** `alert` means the PR has the problem; `ok` means it was checked and does not. */
  readonly tone: "alert" | "ok" | "unknown";
}

/** One status per requested signal, worded the same on every client. */
export function pullRequestSignalStatuses(
  signals: readonly QuickActionSignal[],
  state: PullRequestSignalState,
): PullRequestSignalStatus[] {
  return signals.map((signal): PullRequestSignalStatus => {
    if (signal === "ci") {
      const checks = state.checks;
      return checks === "failing"
        ? { signal, label: "CI failing", tone: "alert" }
        : checks === "passing"
          ? { signal, label: "CI passing", tone: "ok" }
          : checks === "pending"
            ? { signal, label: "CI running", tone: "unknown" }
            : checks === "none"
              ? { signal, label: "No checks", tone: "ok" }
              : { signal, label: "CI unknown", tone: "unknown" };
    }
    if (signal === "conflicts") {
      return state.mergeability === "conflicting"
        ? { signal, label: "Merge conflicts", tone: "alert" }
        : state.mergeability === "mergeable"
          ? { signal, label: "No conflicts", tone: "ok" }
          : { signal, label: "Conflicts unknown", tone: "unknown" };
    }
    if (signal === "base") {
      const behindBy = state.behindBy;
      return state.baseComparison === "behind"
        ? {
            signal,
            label:
              behindBy === undefined
                ? "Behind base"
                : `${behindBy} ${behindBy === 1 ? "commit" : "commits"} behind base`,
            tone: "alert",
          }
        : state.baseComparison === "up-to-date"
          ? { signal, label: "Up to date with base", tone: "ok" }
          : { signal, label: "Base status unknown", tone: "unknown" };
    }
    const threads = state.reviewThreads;
    if (!threads) return { signal, label: "Review threads unknown", tone: "unknown" };
    const count = `${threads.unresolved}${threads.truncated ? "+" : ""}`;
    return threads.unresolved === 0 && !threads.truncated
      ? { signal, label: "No unresolved threads", tone: "ok" }
      : threads.unresolved === 0
        ? { signal, label: "Review threads unknown", tone: "unknown" }
        : {
            signal,
            label: `${count} unresolved ${threads.unresolved === 1 && !threads.truncated ? "thread" : "threads"}`,
            tone: "alert",
          };
  });
}

/**
 * What fresh queries say about one PR, for `quickActionTargets`. A query that has not loaded
 * adds nothing, so the synced snapshot still speaks for those fields.
 */
export function pullRequestKnownState(
  detail: PullRequestDetail | null,
  activity: Pick<PullRequestActivity, "reviewThreads" | "reviewThreadsTruncated"> | null,
): PullRequestKnownState {
  return {
    ...(detail
      ? {
          checks: classifyPullRequestChecks(detail.checks),
          mergeability: detail.mergeability,
          baseComparison: detail.baseComparison,
          behindBy: detail.behindBy,
        }
      : {}),
    ...(activity ? { reviewThreads: unresolvedReviewThreads(activity) } : {}),
  };
}

/** Unresolved review threads from a PR's activity, or null before it loads. */
export function unresolvedReviewThreads(
  activity: Pick<PullRequestActivity, "reviewThreads" | "reviewThreadsTruncated"> | null,
): PullRequestSignalState["reviewThreads"] {
  if (!activity) return null;
  return {
    unresolved: activity.reviewThreads.filter((thread) => !thread.isResolved).length,
    truncated: activity.reviewThreadsTruncated === true,
  };
}

/** CI and conflict state from a synced PR snapshot, for targets of a merge. */
export function pullRequestSnapshotStatus(snapshot: QuickActionVariant["snapshot"]): string {
  if (!snapshot) return "Not synced yet";
  return pullRequestSignalStatuses(["ci", "conflicts"], {
    checks: snapshot.checksState,
    mergeability: snapshot.mergeability,
  })
    .map((status) => status.label)
    .join(" · ");
}

/** Fresh state over the synced snapshot, field by field; absent fields are unknown. */
const knownState = (variant: QuickActionVariant): PullRequestKnownState => ({
  ...(variant.snapshot
    ? { checks: variant.snapshot.checksState, mergeability: variant.snapshot.mergeability }
    : {}),
  ...variant.fresh,
});

/**
 * Whether a PR has the problem the action reads (CI failures, conflicts, a stale branch, review
 * threads). Null when it reads none or the state is unknown, so incomplete snapshots never block
 * a PR; only fresh state can rule out checks, the base comparison, or review threads.
 */
export function quickActionTargetNeedsAction(
  action: QuickActionShape,
  variant: QuickActionVariant,
): boolean | null {
  const signals = quickActionSignals(action);
  const ci = signals.includes("ci");
  const conflicts = signals.includes("conflicts");
  const base = signals.includes("base");
  const threads = signals.includes("reviewThreads");
  const state = knownState(variant);
  if (!ci && !conflicts && !base && !threads) return null;
  const needs: Array<boolean | null> = [];
  if (ci) needs.push(state.checks == null ? null : state.checks === "failing");
  if (conflicts)
    needs.push(
      state.mergeability == null || state.mergeability === "unknown"
        ? null
        : state.mergeability === "conflicting",
    );
  if (base)
    needs.push(
      state.baseComparison == null || state.baseComparison === "unknown"
        ? null
        : state.baseComparison === "behind",
    );
  if (threads) {
    const known = state.reviewThreads;
    // A truncated list with no unresolved thread in view may still hide one.
    needs.push(
      known == null || (known.unresolved === 0 && known.truncated) ? null : known.unresolved > 0,
    );
  }
  return needs.includes(true) ? true : needs.includes(null) ? null : false;
}

/** "2 of 3 pull requests need this", or just the target count when need is unknown. */
export function describeQuickActionTargets(
  action: QuickActionShape,
  variants: readonly QuickActionVariant[],
): string | null {
  // A PR in a multi-repo workspace can appear once per repository; count it once.
  const pullRequests = new Map<string, QuickActionVariant>();
  for (const variant of variants) {
    const pr = variant.choice.pullRequest;
    if (pr) pullRequests.set(`${pr.host}/${pr.repository}#${pr.number}`, variant);
  }
  const total = pullRequests.size;
  if (total === 0) return variants.length > 1 ? `${variants.length} repositories` : null;
  const noun = total === 1 ? "pull request" : "pull requests";
  const signals = quickActionSignals(action);
  // An action that also reads CI or conflicts may be available for those, so it keeps the need
  // count; only a thread-only action is explained by its thread count.
  if (signals.length === 1 && signals[0] === "reviewThreads") {
    const threads = [...pullRequests.values()].map((variant) => variant.fresh?.reviewThreads);
    if (threads.every((known) => known != null)) {
      const unresolved = threads.reduce((sum, known) => sum + known!.unresolved, 0);
      const more = threads.some((known) => known!.truncated) ? "+" : "";
      return `${unresolved}${more} unresolved ${unresolved === 1 && !more ? "thread" : "threads"} in ${total} ${noun}`;
    }
  }
  const needs = [...pullRequests.values()].map((variant) =>
    quickActionTargetNeedsAction(action, variant),
  );
  if (needs.some((need) => need === null)) return `${total} ${noun}`;
  const count = needs.filter(Boolean).length;
  if (count === 0)
    return total === 1 ? "Pull request doesn't need this" : `None of ${total} ${noun} need this`;
  return `${count} of ${total} ${noun} ${count === 1 ? "needs" : "need"} this`;
}

const pad = (value: number) => String(value).padStart(2, "0");

export interface RenderedQuickAction {
  readonly text: string;
  /** Evidence actions append as a separate block instead of replacing the selection. */
  readonly append: boolean;
  /** Present when the text depends on a PR head; insertion later must re-check it. */
  readonly contexts: readonly ActionContextInput[];
}

/**
 * Renders a template with one captured instant. Client values come from this
 * device; thread, repository, and PR values come from the action's environment.
 */
export async function renderQuickActionText(input: {
  readonly action: QuickAction;
  readonly scope: QuickActionScope;
  readonly choice: QuickActionChoice;
  readonly resolveContext: (
    environmentId: EnvironmentId,
    context: ActionContextInput,
  ) => Promise<ActionContextResult>;
  readonly now?: Date;
  readonly readClipboard: () => Promise<string>;
}): Promise<RenderedQuickAction> {
  const { action, scope, choice } = input;
  const needs = quickActionRequirements(action.template);
  const now = input.now ?? DateTime.toDateUtc(DateTime.nowUnsafe());
  const values: Partial<Record<QuickActionVariable, string>> = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
  if (needs.clipboard) {
    let clipboard: string;
    try {
      clipboard = await input.readClipboard();
    } catch {
      throw new Error("Clipboard access was denied. Allow clipboard access and try again.");
    }
    if (!clipboard) throw new Error("Your clipboard is empty. Copy some text and try again.");
    values.clipboard = clipboard;
  }
  let context: ActionContextInput | null = null;
  if (needs.host) {
    if (scope.projectId === null) throw new Error("This action needs a project.");
    const pullRequest: PullRequestRef | undefined = choice.pullRequest
      ? { projectId: scope.projectId, ...choice.pullRequest }
      : undefined;
    const request: ActionContextInput = {
      projectId: scope.projectId,
      ...(scope.thread ? { threadId: scope.thread.id } : {}),
      ...(choice.bindingId ? { bindingId: choice.bindingId } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(needs.reviewThreads ? { reviewThreads: true } : {}),
    };
    const host = await input.resolveContext(scope.environmentId, request);
    if (host.threadTitle) values["thread.title"] = host.threadTitle;
    values["workspace.repositories"] = host.repositories
      .map(
        (entry) =>
          `${entry.label} · ${entry.mode} · ${entry.repository.path} · ${entry.repository.branch ?? "detached HEAD"}`,
      )
      .join("\n");
    const repository = choice.bindingId
      ? host.repositories.find((entry) => entry.id === choice.bindingId)
      : host.repositories.length === 1
        ? host.repositories[0]
        : undefined;
    if (repository) {
      values["repo.name"] = repository.label;
      values["repo.path"] = repository.repository.path;
      values["repo.branch"] = repository.repository.branch ?? "detached HEAD";
    }
    if (host.pullRequest) {
      values["pr.url"] = host.pullRequest.url;
      values["ci.failures"] = host.pullRequest.failures;
      values["pr.conflicts"] = host.pullRequest.conflicts;
      if (host.pullRequest.reviewThreads !== undefined)
        values["pr.reviewThreads"] = host.pullRequest.reviewThreads;
      context = {
        ...request,
        ...(host.pullRequest.headSha ? { expectedHeadSha: host.pullRequest.headSha } : {}),
      };
    }
  }
  return {
    text: renderQuickAction(action.template, values),
    append: needs.evidence,
    contexts: context ? [context] : [],
  };
}

/** Resolve every selection before changing the draft, preserving every PR head for delayed insertion. */
export async function renderQuickActionSelection(
  input: Omit<Parameters<typeof renderQuickActionText>[0], "choice"> & {
    readonly choices: readonly QuickActionChoice[];
  },
): Promise<RenderedQuickAction> {
  if (input.choices.length === 0) throw new Error("Select at least one target.");
  const now = input.now ?? DateTime.toDateUtc(DateTime.nowUnsafe());
  const rendered: RenderedQuickAction[] = [];
  for (const choice of input.choices) {
    rendered.push(await renderQuickActionText({ ...input, now, choice }));
  }
  const text = rendered.map((entry) => entry.text).join("\n\n---\n\n");
  if (new TextEncoder().encode(text).byteLength > 131072)
    throw new Error("Selected actions exceed 128 KiB. Select fewer targets.");
  return {
    text,
    append: rendered.some((entry) => entry.append),
    contexts: rendered.flatMap((entry) => entry.contexts),
  };
}
