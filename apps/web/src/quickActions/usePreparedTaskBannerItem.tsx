import { ZapIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { actionDispatcher, actionTargetKey } from "./dispatcher";
import { dismissPreparedTask, readPreparedTask, usePreparedTask } from "./preparedTasks";
import { useResolveActionContext } from "./useQuickActions";

/** Text prepared for this composer while it was busy or out of view, offered as a notice. */
export function usePreparedTaskBannerItem(
  target: ComposerThreadTarget,
): ComposerBannerStackItem | null {
  const task = usePreparedTask(target);
  const resolveContext = useResolveActionContext();
  const [busy, setBusy] = useState(false);
  return useMemo(() => {
    if (!task) return null;

    const insert = async () => {
      setBusy(true);
      try {
        // PR evidence is only worth inserting while it still describes the PR head.
        if (task.validation)
          await resolveContext(task.validation.environmentId, task.validation.context);
        if (readPreparedTask(target)?.id !== task.id) return;
        const invocation = actionDispatcher.capture(actionTargetKey(target), "prepared-task", 0);
        const result = invocation
          ? actionDispatcher.insert(invocation, task.prompt, "append")
          : "unavailable-target";
        if (result !== "inserted") {
          toastManager.add({
            type: "error",
            title: "The composer can't take text right now",
            description: "Finish the current approval or question, then insert again.",
          });
          return;
        }
        const store = useComposerDraftStore.getState();
        for (const comment of task.reviewComments ?? []) {
          if (
            store.getComposerDraft(target)?.reviewComments.some((entry) => entry.id === comment.id)
          )
            continue;
          store.addReviewComment(target, comment, { appendReference: false });
        }
        dismissPreparedTask(target, task.id);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not insert ${task.title}`,
          description:
            error instanceof Error ? error.message : "Its context changed. Run the action again.",
        });
      } finally {
        setBusy(false);
      }
    };

    return {
      id: `prepared-task:${task.id}`,
      variant: "info",
      icon: <ZapIcon />,
      title: `${task.title} is ready`,
      description: "Insert adds it to the end of your draft.",
      actions: (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void insert()}>
          Insert
        </Button>
      ),
      dismissLabel: "Discard prepared text",
      onDismiss: () => dismissPreparedTask(target, task.id),
    } satisfies ComposerBannerStackItem;
  }, [busy, resolveContext, target, task]);
}
