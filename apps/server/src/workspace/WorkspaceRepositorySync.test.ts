import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ThreadPullRequestLink,
  type VcsStatusLocalResult,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceRepositorySync from "./WorkspaceRepositorySync.ts";

const THREAD_ID = ThreadId.make("thread-1");
const NOW = DateTime.makeUnsafe("2026-10-07T00:00:00.000Z");

const binding = (id: string, state: WorkspaceBinding["state"] = "ready"): WorkspaceBinding => ({
  id,
  label: id,
  sourcePath: `/source/${id}`,
  mode: "new-worktree",
  commonDir: `/source/${id}/.git`,
  checkoutPath: `/worktrees/${id}`,
  branch: `t3/${id}`,
  head: "abc",
  baseCommit: "abc",
  state,
  owned: true,
  error: null,
});

const threadWith = (input: {
  readonly bindings: ReadonlyArray<WorkspaceBinding>;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
}) => ({
  ...v2PullRequestThread({
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: input.pullRequests ?? [],
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
  }),
  workspace: {
    schemaVersion: 1 as const,
    revision: 1,
    operationId: CommandId.make("workspace-operation"),
    state: "ready" as const,
    primaryBindingId: input.bindings[0]!.id,
    bindings: [...input.bindings],
  },
});

const runCompleted: OrchestrationV2DomainEvent = {
  id: EventId.make("event:run-completed"),
  type: "run.updated",
  threadId: THREAD_ID,
  runId: RunId.make("run-1"),
  occurredAt: NOW,
  payload: {
    id: RunId.make("run-1"),
    threadId: THREAD_ID,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make("message-1"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    checkpointId: null,
    contextHandoffId: null,
  },
};

const localStatus = (refName: string, isDefaultRef = false): VcsStatusLocalResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef,
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

/** Runs the sync after one completed run and reports what it refreshed and dispatched. */
const syncAfterRun = Effect.fn("syncAfterRun")(function* (input: {
  readonly thread: ReturnType<typeof threadWith>;
  /** Each checkout's current branch; a missing one is on its default branch. */
  readonly branches: Readonly<Record<string, string>>;
  /** The pull request URL on each branch. */
  readonly pullRequests: Readonly<Record<string, string>>;
}) {
  const activation = yield* Deferred.make<void>();
  const threadRead = yield* Deferred.make<void>();
  const refreshed: string[] = [];
  const prRefreshed: string[] = [];
  const commands: OrchestrationV2ServerCommand[] = [];
  const layerDependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      // Delivered once the parked subscription starts, then the stream stays open.
      streamDomainEvents: Stream.concat(Stream.make(runCompleted), Stream.never),
      getThreadShell: () => Deferred.succeed(threadRead, undefined).pipe(Effect.as(input.thread)),
      dispatch: (command) =>
        Effect.sync(() => commands.push(command)).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshLocalStatus: (cwd) =>
        Effect.sync(() => {
          refreshed.push(cwd);
          const branch = input.branches[cwd];
          return branch === undefined ? localStatus("main", true) : localStatus(branch);
        }),
      refreshPullRequestStatus: (cwd) =>
        Effect.sync(() => {
          prRefreshed.push(cwd);
          return null;
        }),
    }),
    Layer.mock(GitManager.GitManager)({
      branchPullRequest: ({ branch }) =>
        Effect.succeed(
          input.pullRequests[branch] === undefined
            ? null
            : {
                number: Number(input.pullRequests[branch]!.split("/").at(-1)),
                title: "Change",
                url: input.pullRequests[branch]!,
                baseRef: "main",
                headRef: branch,
                state: "open" as const,
                repositoryKey: null,
                updatedAt: null,
              },
        ),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  yield* Effect.gen(function* () {
    const service = yield* WorkspaceRepositorySync.make;
    yield* service.start();
    yield* Deferred.succeed(activation, undefined);
    // The worker reads the thread first, so the run has been enqueued once it does.
    yield* Deferred.await(threadRead);
    yield* service.drain;
  }).pipe(Effect.provide(layerDependencies));
  return { refreshed, prRefreshed, commands };
});

describe("WorkspaceRepositorySync", () => {
  it.effect("refreshes every ready repository and links each branch's pull request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* syncAfterRun({
          thread: threadWith({
            bindings: [binding("web"), binding("api"), binding("docs"), binding("cli", "failed")],
          }),
          branches: { "/worktrees/web": "t3/web", "/worktrees/api": "feature/api" },
          pullRequests: {
            "t3/web": "https://github.com/acme/web/pull/12",
            "feature/api": "https://github.com/acme/api/pull/7",
          },
        });
        // A failed checkout is skipped; a repository on its default branch is refreshed only.
        expect(result.refreshed.toSorted()).toEqual([
          "/worktrees/api",
          "/worktrees/docs",
          "/worktrees/web",
        ]);
        expect(
          result.commands
            .map((command) => command.type === "thread.pull-request.link" && command)
            .filter(Boolean)
            .map((command) => command && [command.bindingId, command.repository, command.number])
            .toSorted(),
        ).toEqual([
          ["api", "acme/api", 7],
          ["web", "acme/web", 12],
        ]);
        // Clients' status reads of each feature branch learn its pull request too.
        expect(result.prRefreshed.toSorted()).toEqual(["/worktrees/api", "/worktrees/web"]);
      }),
    ),
  );

  it.effect("keeps dismissed and bound links, and binds a link made without its repository", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const link = (
          repository: string,
          number: number,
          fields: Partial<ThreadPullRequestLink>,
        ): ThreadPullRequestLink => ({
          host: "github.com",
          repository,
          number,
          url: `https://github.com/${repository}/pull/${number}`,
          source: "created",
          linkedAt: "2026-10-07T00:00:00.000Z",
          snapshot: null,
          stack: null,
          ...fields,
        });
        const result = yield* syncAfterRun({
          thread: threadWith({
            bindings: [binding("web"), binding("api"), binding("docs")],
            pullRequests: [
              link("acme/web", 12, { bindingId: "web" }),
              link("acme/api", 7, { source: "stack-dismissed", bindingId: "api" }),
              link("acme/docs", 3, { source: "agent" }),
            ],
          }),
          branches: {
            "/worktrees/web": "t3/web",
            "/worktrees/api": "t3/api",
            "/worktrees/docs": "t3/docs",
          },
          pullRequests: {
            "t3/web": "https://github.com/acme/web/pull/12",
            "t3/api": "https://github.com/acme/api/pull/7",
            "t3/docs": "https://github.com/acme/docs/pull/3",
          },
        });
        expect(result.commands).toMatchObject([
          {
            type: "thread.pull-request.link",
            repository: "acme/docs",
            number: 3,
            source: "agent",
            bindingId: "docs",
          },
        ]);
      }),
    ),
  );

  it.effect("leaves a thread without a repository set to the regular checkout refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = threadWith({ bindings: [binding("web")] });
        const result = yield* syncAfterRun({
          thread,
          branches: { "/worktrees/web": "t3/web" },
          pullRequests: { "t3/web": "https://github.com/acme/web/pull/12" },
        });
        expect(result).toEqual({ refreshed: [], prRefreshed: [], commands: [] });
      }),
    ),
  );
});
