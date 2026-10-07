import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, QuickAction } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { QUICK_ACTION_STARTER_IDS, quickActionRequirements } from "@t3tools/shared/quickActions";
import { FolderGit2Icon, MessageSquareIcon, SquarePenIcon } from "lucide-react";
import { useRef } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../components/CommandPalette.logic";
import type { PullRequestThreadTask } from "../components/pullRequest/usePullRequestActions";
import { toastManager } from "../components/ui/toast";
import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { useEnvironmentOperateAccess } from "../hooks/useEnvironmentOperateAccess";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { readThreadShell, useThreadShells } from "../state/entities";
import { quickActionsEnvironment } from "../state/quickActions";
import { useAtomCommand } from "../state/use-atom-command";
import { actionDispatcher, actionTargetKey } from "./dispatcher";
import { prepareTask } from "./preparedTasks";
import { insertQuickActionText, renderQuickActionText } from "./quickActionRunner";
import { useResolveActionContext } from "./useQuickActions";

const EVIDENCE_VARIABLE = { ci: "ci.failures", conflicts: "pr.conflicts" } as const;

/**
 * Puts a PR task into a thread's composer: the thread it was asked from, or one the
 * user picks. It never creates a thread or checkout unless the user chooses "new thread".
 */
export function useTaskDestination(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  target: ComposerThreadTarget | null,
) {
  const lock = useRef(false);
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const resolveContext = useResolveActionContext();
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

  // The user's edited CI or conflict instruction, or the button's own text if they deleted it.
  const instructionFor = async (
    kind: "ci" | "conflicts",
    ownerProject: ProjectId,
    fallback: string,
  ): Promise<QuickAction> => {
    const library = await reload({ environmentId, input: { projectId: ownerProject } });
    if (library._tag === "Failure") throw squashAtomCommandFailure(library);
    const starterId =
      kind === "ci"
        ? QUICK_ACTION_STARTER_IDS.resolveCi
        : QUICK_ACTION_STARTER_IDS.resolveConflicts;
    const starter = library.value.find((action) => action.id === starterId && action.enabled);
    const template = starter?.template ?? fallback.replaceAll("{{", "\\{{");
    // The button exists to deliver the evidence, so an edited template still gets it.
    const withEvidence = quickActionRequirements(template).evidence
      ? template
      : `${template}\n\n{{${EVIDENCE_VARIABLE[kind]}}}`;
    const now = new Date().toISOString();
    return {
      id: starter?.id ?? starterId,
      name: starter?.name ?? (kind === "ci" ? "Resolve CI" : "Resolve merge conflicts"),
      description: "",
      aliases: [],
      tags: [],
      category: null,
      projectId: null,
      enabled: true,
      favorite: false,
      revision: starter?.revision ?? 0,
      createdAt: starter?.createdAt ?? now,
      updatedAt: starter?.updatedAt ?? now,
      template: withEvidence,
    };
  };

  const deliver = async (
    destination: ComposerThreadTarget,
    task: PullRequestThreadTask,
    bindingId?: string,
  ) => {
    if (lock.current || !canOperate) return;
    lock.current = true;
    // Capture first: the destination is fixed even if focus moves while context loads.
    const invocation = actionDispatcher.capture(
      actionTargetKey(destination),
      "pull-request-task",
      0,
    );
    const loading = task.context
      ? toastManager.add({ type: "loading", title: "Collecting pull request context…" })
      : null;
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
        throw new Error("This pull request and that thread are on different machines.");
      const ownerProject = draft?.projectId ?? thread?.projectId ?? projectId;
      if (!ownerProject) throw new Error("The thread's project is unavailable.");

      if (!task.context) {
        if (loading) toastManager.close(loading);
        deliverText(destination, invocation, task.prompt, task);
        return;
      }
      const bindings = thread?.workspace?.bindings ?? [];
      const link = thread?.pullRequests.find(
        (entry) =>
          entry.number === task.context!.reference.number &&
          entry.repository.toLowerCase() === task.context!.reference.repository.toLowerCase(),
      );
      const chosenBinding = bindingId ?? link?.bindingId;
      if (bindings.length > 1 && chosenBinding === undefined) {
        if (loading) toastManager.close(loading);
        if (invocation) actionDispatcher.cancel(invocation);
        chooseRepository(destination, task, bindings);
        return;
      }
      const action = await instructionFor(task.context.kind, ownerProject, task.prompt);
      const rendered = await renderQuickActionText({
        action,
        scope: { environmentId, projectId: ownerProject, thread },
        choice: {
          ...(chosenBinding ? { bindingId: chosenBinding } : {}),
          pullRequest: {
            host: task.context.reference.host ?? "github.com",
            repository: task.context.reference.repository,
            number: task.context.reference.number,
          },
        },
        resolveContext,
      });
      if (loading) toastManager.close(loading);
      if (
        insertQuickActionText({
          target: destination,
          invocation,
          action,
          rendered: { ...rendered, append: true },
          environmentId,
          projectId: ownerProject,
          ...(task.reviewComments ? { reviewComments: task.reviewComments } : {}),
        })
      )
        addReviewComments(destination, task);
    } catch (failure) {
      if (invocation) actionDispatcher.cancel(invocation);
      const error = {
        type: "error" as const,
        title: "Could not prepare the pull request task",
        description: failure instanceof Error ? failure.message : "Refresh and try again.",
      };
      if (loading) toastManager.update(loading, error);
      else toastManager.add(error);
    } finally {
      lock.current = false;
    }
  };

  const chooseRepository = (
    destination: ComposerThreadTarget,
    task: PullRequestThreadTask,
    bindings: ReadonlyArray<{ id: string; label: string; checkoutPath: string }>,
  ) =>
    openCommandPalette({
      view: {
        addonIcon: <FolderGit2Icon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "pull-request-task-repository",
            label: "Which repository is this pull request for?",
            items: bindings.map((binding): CommandPaletteActionItem => ({
              kind: "action",
              value: `binding:${binding.id}`,
              searchTerms: [binding.label, binding.checkoutPath],
              title: binding.label,
              description: binding.checkoutPath,
              icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
              run: () => deliver(destination, task, binding.id),
            })),
          },
        ],
      },
    });

  const openNew = async (task: PullRequestThreadTask) => {
    if (!projectId || lock.current || !canOperate) return;
    const opened = await newThread(scopeProjectRef(environmentId, projectId));
    if (opened) await deliver(opened.draftId, task);
  };

  const request = (task: PullRequestThreadTask) => {
    if (!canOperate) {
      toastManager.add({ type: "error", title: "This connection is read-only" });
      return;
    }
    if (target) {
      void deliver(target, task);
      return;
    }
    // No thread asked for this task, so the user picks one. Never guess the latest thread.
    openCommandPalette({
      view: {
        addonIcon: <MessageSquareIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "pull-request-task-thread",
            label: "Add this task to a thread",
            items: [
              ...threads.map((thread): CommandPaletteActionItem => ({
                kind: "action",
                value: `thread:${thread.id}`,
                searchTerms: [thread.title],
                title: thread.title || "Untitled thread",
                icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
                run: async () => {
                  const destination = scopeThreadRef(environmentId, thread.id);
                  await navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: thread.id },
                  });
                  await deliver(destination, task);
                },
              })),
              ...(projectId
                ? [
                    {
                      kind: "action" as const,
                      value: "new-thread",
                      searchTerms: ["new thread", "open in new thread"],
                      title: "Open in new thread",
                      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
                      run: () => openNew(task),
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    });
  };

  return { request, openNew };
}

function deliverText(
  destination: ComposerThreadTarget,
  invocation: ReturnType<typeof actionDispatcher.capture>,
  text: string,
  task: PullRequestThreadTask,
) {
  const result = invocation ? actionDispatcher.insert(invocation, text, "append") : null;
  if (result === "inserted") {
    addReviewComments(destination, task);
    return;
  }
  prepareTask(destination, {
    title: "Pull request task",
    prompt: text,
    ...(task.reviewComments ? { reviewComments: task.reviewComments } : {}),
  });
}

function addReviewComments(destination: ComposerThreadTarget, task: PullRequestThreadTask) {
  const store = useComposerDraftStore.getState();
  for (const comment of task.reviewComments ?? []) {
    if (
      store.getComposerDraft(destination)?.reviewComments.some((entry) => entry.id === comment.id)
    )
      continue;
    store.addReviewComment(destination, comment, { appendReference: false });
  }
}
