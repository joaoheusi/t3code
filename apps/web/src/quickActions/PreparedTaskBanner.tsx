import { useRef, useState } from "react";
import { useAtomCommand } from "../state/use-atom-command";
import { forkWorkspace } from "../state/forkWorkspace";
import { quickActionsEnvironment } from "../state/quickActions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ComposerThreadTarget } from "../composerDraftStore";
import { Button } from "../components/ui/button";
import { actionDispatcher, actionTargetKey, insertContextualTask } from "./dispatcher";
import { dismissPreparedTask, readPreparedTask, usePreparedTask } from "./preparedTasks";
export function PreparedTaskBanner({ target }: { target: ComposerThreadTarget }) {
  const task = usePreparedTask(target);
  const resolve = useAtomCommand(forkWorkspace.context, { reportFailure: false });
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const insert = async () => {
    if (!task || lock.current) return;
    const invocation = actionDispatcher.capture(actionTargetKey(target), "prepared-task", 1);
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (Date.now() - task.createdAt > 300000) {
        dismissPreparedTask(target, task.id);
        return;
      }
      const validation = task.validation;
      if (validation) {
        if (validation.action) {
          const result = await reload({
            environmentId: validation.environmentId,
            input: { projectId: validation.projectId },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          if (
            !result.value.some(
              (action) =>
                action.enabled &&
                action.id === validation.action!.id &&
                action.revision === validation.action!.revision,
            )
          )
            throw new Error("This action changed or was deleted. Prepare the task again.");
        }
        if (validation.context) {
          const result = await resolve({
            environmentId: validation.environmentId,
            input: validation.context,
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          if (result.value.workspaceRevision !== validation.workspaceRevision)
            throw new Error("The workspace changed. Prepare the task again.");
        }
      }
      if (readPreparedTask(target)?.id !== task.id) return;
      if (insertContextualTask(target, task, invocation)) dismissPreparedTask(target, task.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not validate this task. Prepare it again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (!task) return null;
  return (
    <div role="status">
      {error ? <p role="alert">{error}</p> : null}
      <p>A PR task is ready for this thread. Insertion appends text and preserves the draft.</p>
      <Button type="button" disabled={busy} onClick={() => void insert()}>
        Insert prepared task
      </Button>
      <Button type="button" variant="ghost" onClick={() => dismissPreparedTask(target, task.id)}>
        Cancel
      </Button>
    </div>
  );
}
