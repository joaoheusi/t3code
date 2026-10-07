import {
  CommandId,
  hasRepositorySet,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

/**
 * Keeps every repository of a multi-repository thread as current as a single-repository
 * thread's checkout. Turn finalization refreshes only the thread's own checkout, which for a
 * folder thread is not a repository at all. After each run this re-reads each repository's
 * status, so clients see its Changes totals and pull request, and links the pull request on
 * each repository's branch to the thread under that repository's binding.
 */
export class WorkspaceRepositorySync extends Context.Service<
  WorkspaceRepositorySync,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceRepositorySync") {}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const git = yield* GitManager.GitManager;
  const crypto = yield* Crypto.Crypto;

  const syncRepository = Effect.fn("WorkspaceRepositorySync.syncRepository")(function* (
    threadId: ThreadId,
    binding: WorkspaceBinding,
  ) {
    const cwd = binding.checkoutPath;
    const local = yield* vcsStatus.refreshLocalStatus(cwd);
    // A default branch's pull request belongs to whoever merged into it, not to this thread.
    if (!local.isRepo || local.refName === null || local.isDefaultRef) return;
    const detected = yield* git.branchPullRequest(
      { cwd, branch: local.refName },
      { refresh: true },
    );
    // Clients watching this checkout read its pull request from its status.
    yield* vcsStatus.refreshPullRequestStatus(cwd);
    const parsed = detected === null ? null : parseChangeRequestUrl(detected.url);
    if (detected === null || parsed === null) return;
    // Re-read the links: another repository of this thread may have linked one meanwhile.
    const thread = yield* orchestrator.getThreadShell(threadId);
    if (thread === null || thread.archivedAt !== null) return;
    const key = normalizeThreadPullRequestKey({ ...parsed, url: detected.url });
    const existing = threadPullRequestsOf(thread).find((link) =>
      threadPullRequestKeysEqual(link, key),
    );
    // A link the user dismissed stays dismissed; one made before its repository was known
    // gains the binding.
    if (
      existing !== undefined &&
      (existing.bindingId !== undefined || existing.source === "stack-dismissed")
    )
      return;
    const uuid = yield* crypto.randomUUIDv4;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make(`server:workspace-pull-request:${threadId}:${uuid}`),
      threadId,
      ...key,
      url: detected.url,
      source: existing?.source ?? "created",
      bindingId: binding.id,
    });
  });

  const syncThread = Effect.fn("WorkspaceRepositorySync.syncThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* orchestrator.getThreadShell(threadId);
    if (thread === null || thread.archivedAt !== null || !hasRepositorySet(thread.workspace))
      return;
    yield* Effect.forEach(
      thread.workspace.bindings.filter((binding) => binding.state === "ready"),
      (binding) =>
        syncRepository(threadId, binding).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("workspace repository refresh failed", {
                threadId,
                bindingId: binding.id,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      // Each repository may ask its host for a pull request; keep that to a few at a time.
      { concurrency: 4, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    syncThread(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("workspace repository sync failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status)
      ? worker.enqueue(event.threadId)
      : Effect.void;

  const start: WorkspaceRepositorySync["Service"]["start"] = () =>
    forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));

  return { start, drain: worker.drain } satisfies WorkspaceRepositorySync["Service"];
});
