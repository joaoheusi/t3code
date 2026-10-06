import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ComposerThreadTarget } from "../composerDraftStore";
import type { PullRequestThreadTask } from "../components/pullRequest/usePullRequestActions";
import { useThreadShells } from "../state/entities";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "../components/ui/dialog";
import { insertContextualTask } from "./dispatcher";
import { prepareTask } from "./preparedTasks";

/** A global PR has no implicit composer. The destination must be chosen before any write. */
export function useTaskDestination(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  target: ComposerThreadTarget | null,
) {
  const [task, setTask] = useState<PullRequestThreadTask | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      thread.deletedAt === null,
  );
  const newThread = useNewThreadHandler();
  const navigate = useNavigate();
  const request = (next: PullRequestThreadTask) => {
    if (target !== null) {
      if (!insertContextualTask(target, next)) prepareTask(target, next);
      return;
    }
    setTask(next);
  };
  const openNew = async (next = task) => {
    if (!next || !projectId || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const opened = await newThread(scopeProjectRef(environmentId, projectId));
      if (opened) {
        prepareTask(opened.draftId, next);
        setTask(null);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const chooser = (
    <Dialog
      open={task !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setTask(null);
      }}
    >
      <DialogPopup data-quick-actions>
        <DialogHeader>
          <DialogTitle>Choose a thread for this PR task</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p>The task will remain editable. No checkout or message is created automatically.</p>
          {threads.map((thread) => (
            <Button
              type="button"
              key={thread.id}
              disabled={busy}
              variant="ghost"
              onClick={() => {
                if (!task) return;
                const destination = scopeThreadRef(environmentId, thread.id);
                prepareTask(destination, task);
                setTask(null);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: thread.id },
                });
              }}
            >
              {thread.title}
            </Button>
          ))}
          <Button
            type="button"
            disabled={busy || projectId === null}
            onClick={() => void openNew()}
          >
            Open in new thread
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setTask(null)}>
            Cancel
          </Button>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
  return { request, openNew, chooser };
}
