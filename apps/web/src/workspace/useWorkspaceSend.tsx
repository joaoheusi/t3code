import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ThreadWorkspace,
  type WorkspaceConfiguration,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FolderGit2Icon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import { workspaceProgress } from "./workspaceModel";
import { useWorkspaceUiStore } from "./workspaceStores";

/**
 * A thread's repositories are prepared before its first message. Sending from a
 * draft with extra repositories creates the thread, records the workspace, and
 * queues the message here until every repository is ready.
 */
export function useStartWorkspaceThread() {
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      /** Null when the thread already exists and only needs its repositories. */
      readonly createThread: {
        readonly title: string;
        readonly modelSelection: ModelSelection;
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      } | null;
      readonly configuration: WorkspaceConfiguration;
      readonly prompt: string;
      readonly draftKey: string;
    }): Promise<boolean> => {
      const threadKey = scopedThreadKey(scopeThreadRef(input.environmentId, input.threadId));
      const store = useWorkspaceUiStore.getState();
      try {
        if (input.createThread) {
          const created = await dispatch({
            environmentId: input.environmentId,
            input: {
              type: "thread.create",
              commandId: CommandId.make(randomUUID()),
              threadId: input.threadId,
              projectId: input.projectId,
              ...input.createThread,
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            },
          });
          if (created._tag === "Failure") throw squashAtomCommandFailure(created);
        }
        const configured = await dispatch({
          environmentId: input.environmentId,
          input: {
            type: "thread.metadata.update",
            commandId: CommandId.make(randomUUID()),
            threadId: input.threadId,
            workspaceConfiguration: input.configuration,
          },
        });
        if (configured._tag === "Failure") throw squashAtomCommandFailure(configured);
        // On failure the selection stays, so the chip still shows it and Send can retry.
        store.setDraftRepositories(input.draftKey, null);
        store.setPendingSend(threadKey, input.prompt);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't prepare the repositories",
          description: error instanceof Error ? error.message : "Try sending again.",
        });
        return false;
      }
    },
    [dispatch],
  );
}

/** Sends the queued first message once every repository is ready, unless the draft changed. */
export function useSendWhenWorkspaceReady(input: {
  readonly threadKey: string;
  readonly workspace: ThreadWorkspace | undefined;
  readonly readPrompt: () => string;
  readonly send: () => void;
}): void {
  const pending = useWorkspaceUiStore((state) => state.pendingSends[input.threadKey] ?? null);
  const sendRef = useRef(input.send);
  const readPromptRef = useRef(input.readPrompt);
  useEffect(() => {
    sendRef.current = input.send;
    readPromptRef.current = input.readPrompt;
  });
  const state = input.workspace?.state;
  useEffect(() => {
    if (!pending || state === undefined) return;
    // A failed preparation keeps the message queued for Retry; cancelling drops it.
    if (state === "cancelled") {
      useWorkspaceUiStore.getState().setPendingSend(input.threadKey, null);
      return;
    }
    if (state !== "ready") return;
    useWorkspaceUiStore.getState().setPendingSend(input.threadKey, null);
    // Edited text is the user's to send; only the message they sent waits here.
    if (readPromptRef.current() === pending.prompt) sendRef.current();
  }, [input.threadKey, pending, state]);
}

/** Preparation progress and failures, shown above the composer like other thread notices. */
export function useWorkspaceBannerItem(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly workspace: ThreadWorkspace | undefined;
}): ComposerBannerStackItem | null {
  const { workspace } = input;
  const sendQueued = useWorkspaceUiStore((state) =>
    input.threadId
      ? state.pendingSends[scopedThreadKey(scopeThreadRef(input.environmentId, input.threadId))] !==
        undefined
      : false,
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const { environmentId, threadId: inputThreadId } = input;
  return useMemo((): ComposerBannerStackItem | null => {
    if (!workspace || !inputThreadId || workspace.state === "ready") return null;
    const threadId = inputThreadId;
    const control = async (type: "retry" | "cancel") => {
      setBusy(true);
      const result = await dispatch({
        environmentId,
        input: {
          type: "thread.metadata.update",
          commandId: CommandId.make(randomUUID()),
          threadId,
          workspaceControl: { type, expectedRevision: workspace.revision },
        },
      });
      setBusy(false);
      if (result._tag === "Failure")
        toastManager.add({
          type: "error",
          title: type === "retry" ? "Couldn't retry" : "Couldn't cancel",
          description: String(squashAtomCommandFailure(result)),
        });
    };
    const progress = workspaceProgress(workspace);
    if (workspace.state === "failed") {
      const [first, ...others] = progress.failed;
      return {
        id: `workspace:${threadId}:failed:${workspace.revision}`,
        variant: "error",
        priority: "urgent",
        icon: <TriangleAlertIcon />,
        title: first
          ? `Couldn't prepare ${first.label}${others.length > 0 ? ` and ${others.length} more` : ""}`
          : "Couldn't prepare the repositories",
        ...(first?.error ? { description: first.error } : {}),
        actions: (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void control("cancel")}
            >
              Cancel
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void control("retry")}>
              Retry
            </Button>
          </>
        ),
      };
    }
    if (workspace.state === "cancelled") {
      return {
        id: `workspace:${threadId}:cancelled:${workspace.revision}`,
        variant: "warning",
        icon: <FolderGit2Icon />,
        title: "Repository preparation was cancelled",
        description: "Change the repositories under the composer to prepare them again.",
      };
    }
    return {
      id: `workspace:${threadId}:preparing`,
      variant: "info",
      icon: <Spinner />,
      title: `Preparing repositories · ${progress.ready} of ${progress.total} ready`,
      ...(sendQueued ? { description: "Your message sends when they're ready." } : {}),
      actions: (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void control("cancel")}>
          Cancel
        </Button>
      ),
    };
  }, [busy, dispatch, environmentId, inputThreadId, sendQueued, workspace]);
}
