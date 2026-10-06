import type { ComposerThreadTarget } from "../composerDraftStore";
import { Button } from "../components/ui/button";
import { insertContextualTask } from "./dispatcher";
import { dismissPreparedTask, usePreparedTask } from "./preparedTasks";
export function PreparedTaskBanner({ target }: { target: ComposerThreadTarget }) {
  const task = usePreparedTask(target);
  if (!task) return null;
  return (
    <div role="status">
      <p>A PR task is ready for this thread. Insertion appends text and preserves the draft.</p>
      <Button
        type="button"
        onClick={() => {
          if (Date.now() - task.createdAt > 300000) {
            dismissPreparedTask(target, task.id);
            return;
          }
          if (insertContextualTask(target, task)) dismissPreparedTask(target, task.id);
        }}
      >
        Insert prepared task
      </Button>
      <Button type="button" variant="ghost" onClick={() => dismissPreparedTask(target, task.id)}>
        Cancel
      </Button>
    </div>
  );
}
