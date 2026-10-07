import {
  ActionDispatcher,
  type ActionEditor,
  type ActionInvocation,
} from "@t3tools/client-runtime/actions/dispatcher";
import {
  composerTargetKey,
  resolveComposerDraftKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { randomUUID } from "../lib/utils";

export type { ActionInvocation };

/** Composers register here so actions started elsewhere insert into the composer they captured. */
export const actionDispatcher = new ActionDispatcher(Date.now, randomUUID);
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
