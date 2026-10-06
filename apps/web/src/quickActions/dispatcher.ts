import { ActionDispatcher } from "@t3tools/client-runtime/actions/dispatcher";
import {
  composerTargetKey,
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import type { ActionEditor } from "@t3tools/client-runtime/actions/dispatcher";
import { toastManager } from "../components/ui/toast";
import type { ReviewCommentContext } from "../reviewCommentContext";

export const actionDispatcher = new ActionDispatcher();
export const actionTargetKey = (target: ComposerThreadTarget) => composerTargetKey(target);

const draftRevisions = new Map<string, number>();
useComposerDraftStore.subscribe((state, previous) => {
  const keys = new Set([
    ...Object.keys(state.draftsByThreadKey),
    ...Object.keys(previous.draftsByThreadKey),
  ]);
  for (const key of keys) {
    if (state.draftsByThreadKey[key] !== previous.draftsByThreadKey[key])
      draftRevisions.set(key, (draftRevisions.get(key) ?? 0) + 1);
  }
});

export function registerActionEditor(
  target: ComposerThreadTarget,
  editor: Omit<ActionEditor, "read"> & {
    read: () => Omit<ReturnType<ActionEditor["read"]>, "revision">;
  },
): () => void {
  return actionDispatcher.register(actionTargetKey(target), {
    ...editor,
    read: () => ({
      ...editor.read(),
      revision:
        draftRevisions.get(
          resolveComposerDraftKey(useComposerDraftStore.getState(), target) ?? "",
        ) ?? 0,
    }),
  });
}

/** Application-owned PR tasks append text; user text and existing context records are retained. */
export function insertContextualTask(
  target: ComposerThreadTarget,
  task: { prompt: string; reviewComments?: readonly ReviewCommentContext[] },
): boolean {
  const invocation = actionDispatcher.capture(actionTargetKey(target), "pull-request-task", 1);
  if (!invocation || actionDispatcher.insert(invocation, task.prompt, "append") !== "inserted") {
    toastManager.add({
      type: "error",
      title: "Open the target thread to insert this task",
      description: "The original composer is unavailable. No thread or checkout was created.",
    });
    return false;
  }
  const store = useComposerDraftStore.getState();
  for (const comment of task.reviewComments ?? []) {
    if (
      store.getComposerDraft(target)?.reviewComments.some((existing) => existing.id === comment.id)
    )
      continue;
    store.addReviewComment(target, comment, { appendReference: false });
  }
  return true;
}
