import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ActionContextResult, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ActionInvocation } from "@t3tools/client-runtime/actions/dispatcher";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { renderQuickAction, type QuickActionVariable } from "@t3tools/shared/quickActions";
import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import type { PullRequestThreadTask } from "../components/pullRequest/usePullRequestActions";
import { readThreadShell, useThreadShells } from "../state/entities";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useEnvironmentOperateAccess } from "../hooks/useEnvironmentOperateAccess";
import { useAtomCommand } from "../state/use-atom-command";
import { forkWorkspace } from "../state/forkWorkspace";
import { quickActionsEnvironment } from "../state/quickActions";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "../components/ui/dialog";
import { toastManager } from "../components/ui/toast";
import { actionDispatcher, actionTargetKey, insertContextualTask } from "./dispatcher";
import { prepareTask, type PreparedTask } from "./preparedTasks";

/** Capture the destination before loading context. Changing focus cannot redirect the task. */
export function useTaskDestination(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  target: ComposerThreadTarget | null,
) {
  const [task, setTask] = useState<PullRequestThreadTask | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [choice, setChoice] = useState<{
    task: PullRequestThreadTask;
    target: ComposerThreadTarget;
    invocation: ActionInvocation | null;
    repositories: ActionContextResult["repositories"];
  } | null>(null);
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const resolve = useAtomCommand(forkWorkspace.context, { reportFailure: false });
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      thread.deletedAt === null &&
      thread.archivedAt === null,
  );
  const newThread = useNewThreadHandler();
  const navigate = useNavigate();
  const prepare = async (
    destination: ComposerThreadTarget,
    next: PullRequestThreadTask,
    captured: ActionInvocation | null,
    bindingId?: string,
  ) => {
    if (lock.current || !canOperate) return;
    lock.current = true;
    setBusy(true);
    try {
      const draft =
        typeof destination === "string"
          ? useComposerDraftStore.getState().getDraftSession(destination)
          : null;
      const thread = typeof destination === "string" ? null : readThreadShell(destination);
      const ownerEnvironment =
        draft?.environmentId ??
        (typeof destination === "string" ? null : destination.environmentId);
      if (ownerEnvironment !== environmentId)
        throw new Error(
          "This PR and destination use different execution hosts. Select a thread on the PR's host.",
        );
      const ownerProject = draft?.projectId ?? thread?.projectId ?? projectId;
      if (!ownerProject) throw new Error("The target project is unavailable.");
      let prepared: Omit<PreparedTask, "id" | "createdAt"> = next;
      if (next.context) {
        const result = await resolve({
          environmentId,
          input: {
            projectId: ownerProject,
            ...(typeof destination === "string" ? {} : { threadId: destination.threadId }),
            ...(bindingId ? { bindingId } : {}),
            pullRequest: next.context.reference,
            ...(next.context.headSha ? { expectedHeadSha: next.context.headSha } : {}),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const host = result.value;
        if (host.repositories.length > 1 && !bindingId) {
          setChoice({
            task: next,
            target: destination,
            invocation: captured,
            repositories: host.repositories,
          });
          return;
        }
        if (!host.pullRequest)
          throw new Error("PR context is unavailable. Refresh before preparing this task.");
        const library = await reload({ environmentId, input: { projectId: ownerProject } });
        if (library._tag === "Failure") throw squashAtomCommandFailure(library);
        const actionId =
          next.context.kind === "ci"
            ? "99aa6720-f388-4bbd-aacc-000000000000"
            : "99aa6720-f388-4bbd-aacc-000000000001";
        const action = library.value.find((entry) => entry.id === actionId && entry.enabled);
        const selected =
          host.repositories.find((entry) => entry.id === bindingId) ?? host.repositories[0]!;
        const instant = new Date();
        const values: Partial<Record<QuickActionVariable, string>> = {
          date: instant.toLocaleDateString(),
          time: instant.toLocaleTimeString(),
          "pr.url": host.pullRequest.url,
          "ci.failures": host.pullRequest.failures,
          "workspace.repositories": host.repositories
            .map((entry) => `${entry.label} · ${entry.mode} · ${entry.repository.path}`)
            .join("\n"),
          "repo.name": selected.label,
          "repo.path": selected.repository.path,
          "repo.branch": selected.repository.branch ?? "Detached HEAD",
          ...(host.threadTitle ? { "thread.title": host.threadTitle } : {}),
        };
        // A button never reads clipboard data implicitly. Such templates remain available through the palette.
        const instruction = action ? renderQuickAction(action.template, values) : next.prompt;
        const evidence =
          next.context.kind === "ci" ? host.pullRequest.failures : host.pullRequest.conflicts;
        prepared = {
          prompt: `${instruction}\n\n${evidence}`,
          validation: {
            environmentId,
            projectId: ownerProject,
            ...(action ? { action: { id: action.id, revision: action.revision } } : {}),
            workspaceRevision: host.workspaceRevision,
            context: {
              projectId: ownerProject,
              ...(typeof destination === "string" ? {} : { threadId: destination.threadId }),
              ...(bindingId ? { bindingId } : {}),
              pullRequest: next.context.reference,
              ...(host.pullRequest.headSha ? { expectedHeadSha: host.pullRequest.headSha } : {}),
            },
          },
          ...(next.reviewComments ? { reviewComments: next.reviewComments } : {}),
        };
        if (captured && action)
          captured = actionDispatcher.select(captured, action.id, action.revision);
      }
      setChoice(null);
      setTask(null);
      if (!insertContextualTask(destination, prepared, captured))
        prepareTask(destination, prepared);
    } catch (failure) {
      toastManager.add({
        type: "error",
        title: "Could not prepare the PR task",
        description:
          failure instanceof Error
            ? failure.message
            : "Context is unavailable. Refresh and try again.",
      });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const request = (next: PullRequestThreadTask) => {
    if (!canOperate) {
      toastManager.add({ type: "error", title: "This connection is read only" });
      return;
    }
    if (target) {
      const captured = actionDispatcher.capture(actionTargetKey(target), "pull-request-task", 1);
      void prepare(target, next, captured);
    } else setTask(next);
  };
  const openNew = async (next = task) => {
    if (!next || !projectId || lock.current || !canOperate) return;
    lock.current = true;
    setBusy(true);
    try {
      const opened = await newThread(scopeProjectRef(environmentId, projectId));
      if (opened) {
        lock.current = false;
        await prepare(opened.draftId, next, null);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const chooser = (
    <Dialog
      open={task !== null || choice !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setTask(null);
          setChoice(null);
        }
      }}
    >
      <DialogPopup data-quick-actions>
        <DialogHeader>
          <DialogTitle>
            {choice ? "Choose the repository for this PR task" : "Choose a thread for this PR task"}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p>The task remains editable. No message or checkout is created automatically.</p>
          {choice
            ? choice.repositories.map((entry) => (
                <Button
                  type="button"
                  key={entry.id}
                  disabled={busy}
                  variant="ghost"
                  onClick={() =>
                    void prepare(choice.target, choice.task, choice.invocation, entry.id)
                  }
                >
                  {entry.label} · {entry.repository.path}
                </Button>
              ))
            : threads.map((thread) => (
                <Button
                  type="button"
                  key={thread.id}
                  disabled={busy}
                  variant="ghost"
                  onClick={() => {
                    if (!task) return;
                    const destination = scopeThreadRef(environmentId, thread.id);
                    void prepare(destination, task, null);
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: thread.id },
                    });
                  }}
                >
                  {thread.title}
                </Button>
              ))}
          {!choice ? (
            <Button
              type="button"
              disabled={busy || !projectId || !canOperate}
              onClick={() => void openNew()}
            >
              Open in new thread
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setTask(null);
              setChoice(null);
            }}
          >
            Cancel
          </Button>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
  return { request, openNew, chooser };
}
