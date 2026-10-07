import { useTaskDestination } from "../../quickActions/useTaskDestination";
import type { ComposerThreadTarget } from "../../composerDraftStore";
/**
 * The actions a pull request offers, extracted from the detail panel so smaller surfaces — the
 * thread details panel's pull request row — perform them through the very same code. Two callers
 * running two copies of "merge" or "resolve in a thread" would drift apart one fix at a time;
 * these hooks are where that behavior lives, and the panels are only where it is rendered.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

/** Resolve on demand so hidden quick actions do not rebuild the legacy project grouping. */
export function usePullRequestDefaultMergeMethodResolver(
  environmentId: EnvironmentId,
  projectId: ProjectId,
) {
  const projectDefault = useEnvironmentSettings(
    environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.pullRequestMergeMethod,
  );
  const legacyOverrides = useClientSettings((settings) => settings.pullRequestMergeMethodOverrides);
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(() => {
    if (projectDefault != null) return projectDefault;
    if (Object.keys(legacyOverrides).length === 0) return undefined;
    const project = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    if (!project) return undefined;
    // Duplicate sidebar rows borrow their logical group key from their siblings.
    const key =
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: grouping,
        primaryEnvironmentId,
      }).get(derivePhysicalProjectKey(project)) ??
      deriveLogicalProjectKeyFromSettings(project, grouping);
    return legacyOverrides[key];
  }, [
    projectDefault,
    projects,
    environmentId,
    projectId,
    grouping,
    primaryEnvironmentId,
    legacyOverrides,
  ]);
}

const ACTION_SUCCESS_LABELS: Record<PullRequestAction, string> = {
  merge: "Merge requested",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: "Pull request closed",
  reopen: "Pull request reopened",
  "update-branch": "Branch updated with the base branch",
  "enable-auto-merge": "Auto-merge enabled",
  "disable-auto-merge": "Auto-merge disabled",
  revert: "Revert pull request opened",
  "approve-workflows": "Workflows approved",
};

/** Said as the thing that did not happen, rather than as the operation that returned an error. */
const ACTION_FAILURE_LABELS: Record<PullRequestAction, string> = {
  merge: "Could not merge this pull request",
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: "Could not close this pull request",
  reopen: "Could not reopen this pull request",
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not enable auto-merge",
  "disable-auto-merge": "Could not disable auto-merge",
  revert: "Could not open a revert pull request",
  "approve-workflows": "Could not approve workflows",
};

/** What to try, for the times the host says only that it refused. */
const ACTION_FAILURE_HINTS: Record<PullRequestAction, string> = {
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
  "update-branch":
    "The host refused it. Check that you have write access, and that the base branch has not diverged in a way the host cannot merge.",
  "enable-auto-merge":
    "The host refused it. Check that auto-merge is enabled for this repository and that you have write access.",
  "disable-auto-merge": "The host refused it. Check that you have write access to this repository.",
  revert:
    "The host refused it. Check that you have write access and that this pull request was merged on the host.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
};

/**
 * Runs one host action against a pull request, with the toasts every surface should say the same
 * way. `onSuccess` is where the caller re-reads whatever it is showing.
 */
export function usePullRequestActionRunner({
  environmentId,
  reference,
  onSuccess,
  resolveMergeMethod,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef | null;
  onSuccess?: (action: PullRequestAction) => void;
  /** Small surfaces resolve repository settings on the click, not for every visible row. */
  resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
}) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [actionPending, setActionPending] = useState(false);
  const pendingRef = useRef(false);

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (pendingRef.current || reference === null) return;
    pendingRef.current = true;
    setActionPending(true);
    try {
      const result = await runAction({
        environmentId,
        input: {
          ...reference,
          action,
          ...(method ? { mergeMethod: method } : resolveMergeMethod ? { resolveMergeMethod } : {}),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
      onSuccess?.(action);
    } catch (failure) {
      toastManager.add({
        type: "error",
        title: ACTION_FAILURE_LABELS[action],
        description: readableFailure(failure, ACTION_FAILURE_HINTS[action]),
      });
    } finally {
      pendingRef.current = false;
      setActionPending(false);
    }
  };

  return { actionPending, perform };
}

/** Queue a close sweep through the same environment lanes as individual actions. */
export function usePullRequestCloseBatch(onClosed: (entry: EnvironmentPullRequestEntry) => void) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const pending = useRef(new Set<string>());
  const [closingKeys, setClosingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const close = useCallback(
    async (entries: readonly EnvironmentPullRequestEntry[]) => {
      const batch = entries.filter((entry) => {
        const key = pullRequestEntryKey(entry);
        if (entry.state !== "open" || entry.provider !== "github" || pending.current.has(key))
          return false;
        pending.current.add(key);
        return true;
      });
      if (batch.length === 0) return;
      setClosingKeys(new Set(pending.current));
      let closed = 0;
      const failures: string[] = [];
      await Promise.all(
        batch.map(async (entry) => {
          try {
            const result = await runAction({
              environmentId: entry.environmentId,
              input: {
                projectId: entry.projectId,
                host: entry.host,
                repository: entry.repository,
                number: entry.number,
                action: "close",
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            closed++;
            onClosed(entry);
          } catch (failure) {
            failures.push(
              `#${entry.number}: ${readableFailure(failure, ACTION_FAILURE_HINTS.close)}`,
            );
          } finally {
            pending.current.delete(pullRequestEntryKey(entry));
            setClosingKeys(new Set(pending.current));
          }
        }),
      );
      toastManager.add({
        type: failures.length > 0 ? "error" : "success",
        title:
          failures.length > 0
            ? `Closed ${closed} of ${batch.length} pull requests`
            : `Closed ${closed} pull request${closed === 1 ? "" : "s"}`,
        ...(failures.length > 0 ? { description: failures.slice(0, 3).join("\n") } : {}),
      });
    },
    [onClosed, runAction],
  );
  return { close, closingKeys };
}

export interface PullRequestThreadTask {
  prompt: string;
  context?: {
    kind: "ci" | "conflicts";
    reference: import("@t3tools/contracts").PullRequestRef;
    headSha?: string;
  };
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

/** What a hand-off needs to know about the pull request it is handing over. */
export type PullRequestHandoffDetail = Pick<
  PullRequestDetail,
  "projectId" | "workspaceRoot" | "url"
>;

/**
 * The hand-offs from a pull request into a thread: a question that needs nothing checked out, and
 * a task that needs the branch under the agent's feet first. One `handoff` key holds them all to
 * one at a time, whatever surface pressed the button.
 */
export function usePullRequestHandoffs({
  environmentId,
  detail,
  target = null,
}: {
  environmentId: EnvironmentId;
  target?: ComposerThreadTarget | null;
  detail: PullRequestHandoffDetail | null;
}) {
  const destination = useTaskDestination(environmentId, detail?.projectId ?? null, target);
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });
  // Which handoff is preparing, keyed so a per-finding button can say "Preparing..." on itself
  // alone. One at a time whatever the key: they all check the same pull request out.
  const [handoff, setHandoff] = useState<string | null>(null);

  /** A question about the change, which needs a thread and nothing else. */
  const startAsk = async (_kind: string, task: PullRequestThreadTask) => {
    if (detail && handoff === null) {
      destination.request(task);
    }
  };

  // Text tasks use the captured composer. Only an explicit checkout prepares a worktree.
  const startHandoff = async (
    kind: string,
    task: PullRequestThreadTask | null,
    // A worktree leaves whatever is open alone, which is why it is the default. Checking out in
    // the repository itself is what you want when the point is to run the thing where you
    // already work — and it moves the branch under everything else that is open there.
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    if (task !== null) {
      destination.request(task);
      return;
    }

    setHandoff(kind);
    // The menu closes on the press and takes its "Preparing..." label with it, so this is the
    // only thing answering for the checkout. It carries no timeout of its own: a loading toast
    // never expires, and an explicit one would survive the update and pin the result on screen.
    const toastId = toastManager.add({
      type: "loading",
      title: "Preparing the pull request checkout...",
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // The thread is opened before the checkout rather than after it, because the project's setup
    // script only runs for a checkout that knows which thread it is for — and a worktree with no
    // dependencies installed is not something anyone can test.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (opened === null) {
      setHandoff(null);
      // Without a thread there is nowhere for the checkout to belong: its setup script would not
      // run and its task would have no composer to land in. Better to stop before touching the
      // working tree than to prepare a worktree nobody asked for.
      toastManager.update(toastId, {
        type: "error",
        title: "Could not open a thread for the checkout",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: detail.url,
      mode,
      threadId: opened.threadId,
    });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      // The server says what to do about it — that the branch is already checked out in the main
      // repository, say — and that sentence is the only way out of the failure.
      const detailMessage =
        prepareThread.error instanceof Error ? prepareThread.error.message : null;
      toastManager.update(toastId, {
        type: "error",
        title: "Could not prepare the pull request checkout",
        ...(detailMessage ? { description: detailMessage } : {}),
      });
      return;
    }
    // The same thread again, now that there is somewhere to point it at. A local checkout has
    // no worktree of its own, so the thread runs where the repository already is.
    const pointed = await newThread(projectRef, {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: prepared.value.worktreePath === null ? "local" : "worktree",
    }).then(
      (session) => session !== null,
      () => false,
    );
    if (!pointed) {
      setHandoff(null);
      // The checkout is on disk; only the thread failed to move onto it. Writing the task now
      // would send the agent at whatever the thread was already open on — which is the one
      // outcome worth stopping for, since it reads as success and is not.
      toastManager.update(toastId, {
        type: "error",
        title: "Checked out, but the thread stayed where it was",
        description: `The checkout is ready on \`${prepared.value.branch}\`. Point a thread at it from the branch picker, then ask again.`,
      });
      return;
    }
    // Released here whatever happened next: a loading toast never expires on its own, so leaving
    // this set would spin forever and lock every handoff behind it until a reload.
    setHandoff(null);
    // A worktree that was already there and had been worked in keeps whatever it holds, so the
    // thread opens on older code than the pull request carries. Said once, in place of the
    // success, because everything else about the handoff did happen.
    const staleCheckoutToast = {
      type: "warning",
      title: "Checked out, but not on the latest commits",
      description:
        "The checkout could not be moved onto the pull request's latest commits, so the code there is older than the pull request. Uncommitted work or local commits keep it where it is.",
    } as const;
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: mode === "local" ? "Checked out here" : "Checked out",
            description:
              mode === "local"
                ? "This repository is on the pull request's branch, with a thread open on it."
                : "The pull request is in its own worktree, with a thread open on it.",
          }
        : staleCheckoutToast,
    );
    return;
  };

  return {
    handoff,
    startAsk,
    startHandoff,
    openNew: destination.openNew,
  };
}
