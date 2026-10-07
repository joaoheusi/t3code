import type {
  ActionContextInput,
  ActionContextResult,
  EnvironmentId,
  ProjectId,
  PullRequestRef,
  QuickAction,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  quickActionRequirements,
  renderQuickAction,
  type QuickActionVariable,
} from "@t3tools/shared/quickActions";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import type { ComposerThreadTarget } from "../composerDraftStore";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { toastManager } from "../components/ui/toast";
import { actionDispatcher, actionTargetKey, type ActionInvocation } from "./dispatcher";
import { prepareTask } from "./preparedTasks";

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
}

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
 */
export function quickActionTargets(
  action: QuickAction,
  scope: QuickActionScope,
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
        choice: {
          ...(bindingId ? { bindingId } : {}),
          ...(link
            ? { pullRequest: { host: link.host, repository: link.repository, number: link.number } }
            : {}),
        },
      });
    }
  }
  return { kind: "ready", variants };
}

const pad = (value: number) => String(value).padStart(2, "0");

export interface RenderedQuickAction {
  readonly text: string;
  /** Evidence actions append as a separate block instead of replacing the selection. */
  readonly append: boolean;
  /** Present when the text depends on a PR head; insertion later must re-check it. */
  readonly context: ActionContextInput | null;
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
}): Promise<RenderedQuickAction> {
  const { action, scope, choice } = input;
  const needs = quickActionRequirements(action.template);
  const now = input.now ?? new Date();
  const values: Partial<Record<QuickActionVariable, string>> = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
  if (needs.clipboard) {
    let clipboard: string;
    try {
      clipboard = await navigator.clipboard.readText();
    } catch {
      throw new Error("Clipboard access was denied. Allow clipboard access and try again.");
    }
    if (!clipboard) throw new Error("Your clipboard is empty. Copy some text and try again.");
    values.clipboard = clipboard;
  }
  let context: RenderedQuickAction["context"] = null;
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
      context = {
        ...request,
        ...(host.pullRequest.headSha ? { expectedHeadSha: host.pullRequest.headSha } : {}),
      };
    }
  }
  return { text: renderQuickAction(action.template, values), append: needs.evidence, context };
}

const recentIds: string[] = [];
/** Session-local usage order; ranking reads it between invocations. */
export const recentQuickActionIds = (): readonly string[] => recentIds;
export function noteQuickActionUse(id: string) {
  const index = recentIds.indexOf(id);
  if (index >= 0) recentIds.splice(index, 1);
  recentIds.unshift(id);
  recentIds.length = Math.min(recentIds.length, 20);
}

/**
 * Inserts into the composer captured before any async work. If that draft changed
 * or its composer is gone, the text waits on the original thread as a banner.
 */
export function insertQuickActionText(input: {
  readonly target: ComposerThreadTarget;
  readonly invocation: ActionInvocation | null;
  readonly action: QuickAction;
  readonly rendered: RenderedQuickAction;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly reviewComments?: readonly ReviewCommentContext[];
}): boolean {
  const { invocation, rendered, action } = input;
  const result = invocation
    ? actionDispatcher.insert(invocation, rendered.text, rendered.append ? "append" : "selection")
    : "unavailable-target";
  if (result === "inserted" || result === "already-inserted") {
    noteQuickActionUse(action.id);
    return true;
  }
  prepareTask(input.target, {
    title: action.name,
    prompt: rendered.text,
    ...(input.reviewComments ? { reviewComments: input.reviewComments } : {}),
    ...(rendered.context && input.projectId
      ? { validation: { environmentId: input.environmentId, context: rendered.context } }
      : {}),
  });
  toastManager.add({
    type: "info",
    title: `“${action.name}” is waiting in the composer`,
    description:
      result === "stale-draft"
        ? "The draft changed while context loaded. Insert it from the banner when ready."
        : "Return to that thread to insert it.",
  });
  return false;
}

export function captureQuickActionInvocation(target: ComposerThreadTarget, action: QuickAction) {
  return actionDispatcher.capture(actionTargetKey(target), action.id, action.revision);
}
