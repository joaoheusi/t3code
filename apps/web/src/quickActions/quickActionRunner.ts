import type { EnvironmentId, ProjectId, QuickAction } from "@t3tools/contracts";
import type { ComposerThreadTarget } from "../composerDraftStore";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { toastManager } from "../components/ui/toast";
import { actionDispatcher, actionTargetKey, type ActionInvocation } from "./dispatcher";
import { prepareTask } from "./preparedTasks";

import {
  quickActionTargets,
  renderQuickActionSelection as renderSelection,
  renderQuickActionText as renderText,
  type RenderedQuickAction,
} from "@t3tools/client-runtime/quickActionRunner";
export { quickActionTargets };
export type {
  QuickActionScope,
  QuickActionChoice,
  QuickActionVariant,
  QuickActionTargets,
  RenderedQuickAction,
} from "@t3tools/client-runtime/quickActionRunner";
export const renderQuickActionText = (
  input: Omit<Parameters<typeof renderText>[0], "readClipboard">,
) => renderText({ ...input, readClipboard: () => navigator.clipboard.readText() });
export const renderQuickActionSelection = (
  input: Omit<Parameters<typeof renderSelection>[0], "readClipboard">,
) => renderSelection({ ...input, readClipboard: () => navigator.clipboard.readText() });

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
    ...(rendered.contexts.length > 0 && input.projectId
      ? { validation: { environmentId: input.environmentId, contexts: rendered.contexts } }
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
