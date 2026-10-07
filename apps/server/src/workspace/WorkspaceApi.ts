import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { resolveWorkspaceTerminal } from "@t3tools/shared/workspaceTerminal";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import * as Operations from "./WorkspaceOperations.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ThreadId, type ActionContextInput, type ActionContextResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { buildPullRequestActionContext } from "@t3tools/shared/actionContext";
import * as Schema from "effect/Schema";
import {
  WorkspaceError,
  type WorkspaceBindingTarget,
  type WorkspaceWriteFileInput,
  type ProjectWriteFileResult,
  type ProjectSearchEntriesResult,
  type WorkspaceGitActionInput,
  type ForkWorkspaceStatus,
  type ReviewDiffPreviewResult,
  type ProjectReadFileResult,
  type TerminalSessionSnapshot,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as WorkspaceRepositories from "./WorkspaceRepositories.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const isWorkspaceError = Schema.is(WorkspaceError);
const failure = (cause: unknown) =>
  isWorkspaceError(cause)
    ? cause
    : new WorkspaceError({
        detail: cause instanceof Error ? cause.message : "The workspace operation failed.",
      });
export class WorkspaceApi extends Context.Service<
  WorkspaceApi,
  {
    readonly assertLegacyMutation: (cwd: string) => Effect.Effect<void, WorkspaceError>;
    readonly terminalTarget: (input: {
      threadId: string;
      terminalId: string;
    }) => Effect.Effect<{ cwd: string; worktreePath: null } | null, WorkspaceError>;
    readonly context: (
      input: ActionContextInput,
    ) => Effect.Effect<ActionContextResult, WorkspaceError>;
    readonly status: (
      input: WorkspaceBindingTarget,
    ) => Effect.Effect<ForkWorkspaceStatus, WorkspaceError>;
    readonly diff: (
      input: WorkspaceBindingTarget & { baseRef?: string | undefined },
    ) => Effect.Effect<ReviewDiffPreviewResult, WorkspaceError>;
    readonly writeFile: (
      input: WorkspaceWriteFileInput,
    ) => Effect.Effect<ProjectWriteFileResult, WorkspaceError>;
    readonly search: (
      input: WorkspaceBindingTarget & { query: string },
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceError>;
    readonly readFile: (
      input: WorkspaceBindingTarget & { relativePath: string },
    ) => Effect.Effect<ProjectReadFileResult, WorkspaceError>;
    readonly terminal: (
      input: WorkspaceBindingTarget & { terminalId: string },
    ) => Effect.Effect<TerminalSessionSnapshot, WorkspaceError>;
    readonly gitAction: (
      input: typeof WorkspaceGitActionInput.Type,
    ) => Effect.Effect<GitRunStackedActionResult, WorkspaceError>;
  }
>()("t3/workspace/WorkspaceApi") {}
const make = Effect.gen(function* () {
  const queries = yield* Semaphore.make(4);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const operations = yield* Operations.WorkspaceOperations;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const identities = yield* Identity.RepositoryIdentityResolver;
  const projects = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const review = yield* ReviewService.ReviewService;
  const entries = yield* WorkspaceEntries.WorkspaceEntries;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const path = yield* Path.Path;
  const resolve = Effect.fn("WorkspaceApi.resolve")(function* (
    input: WorkspaceBindingTarget,
    mutating = false,
  ) {
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.mapError(failure));
    const workspace = projection.thread.workspace;
    if (
      !workspace ||
      workspace.revision !== input.expectedRevision ||
      projection.thread.deletedAt !== null
    )
      return yield* failure("The workspace changed or was deleted. Reload before continuing.");
    const binding = workspace.bindings.find((entry) => entry.id === input.bindingId);
    if (!binding || binding.state !== "ready")
      return yield* failure("This repository is not ready. Retry its preparation first.");
    const actual = yield* repositories.inspect(binding.checkoutPath);
    if (actual.path !== binding.checkoutPath || actual.commonDir !== binding.commonDir)
      return yield* failure("The recorded checkout is unavailable or its Git identity changed.");
    if (
      mutating &&
      (projection.thread.archivedAt !== null ||
        actual.branch !== binding.branch ||
        actual.operation !== null ||
        projection.runs.some((run) =>
          ["queued", "preparing", "running", "blocked"].includes(run.status),
        ))
    )
      return yield* failure(
        "This checkout changed branches, has an active Git operation, or its provider is busy. Finish that work before changing Git state.",
      );
    return { ...binding, repository: actual };
  });
  const context = Effect.fn("WorkspaceApi.context")(function* (input: ActionContextInput) {
    const project = yield* projects.getShell(input.projectId).pipe(Effect.mapError(failure));
    if (Option.isNone(project)) return yield* failure("The selected project is unavailable.");
    const projection =
      input.threadId === undefined
        ? null
        : yield* threads.getThreadRecords(input.threadId, []).pipe(Effect.mapError(failure));
    if (
      projection &&
      (projection.thread.projectId !== input.projectId || projection.thread.deletedAt !== null)
    )
      return yield* failure("The thread does not belong to this project or was deleted.");
    const workspace = projection?.thread.workspace;
    if (workspace) yield* repositories.validate(workspace);
    const bindings = workspace?.bindings ?? [
      {
        id: "primary",
        label: project.value.title,
        mode: "current",
        checkoutPath: projection?.thread.worktreePath ?? project.value.workspaceRoot,
      },
    ];
    const resolved = yield* Effect.forEach(
      bindings,
      (binding) =>
        repositories.inspect(binding.checkoutPath).pipe(
          Effect.map((repository) => ({
            id: binding.id,
            label: binding.label,
            mode: binding.mode,
            repository,
          })),
        ),
      { concurrency: 4 },
    );
    if (input.bindingId && !resolved.some((entry) => entry.id === input.bindingId))
      return yield* failure("The selected repository is no longer bound to this thread.");
    const notices: string[] = [];
    let pr: ActionContextResult["pullRequest"] = null;
    if (input.pullRequest) {
      const prProject = yield* projects
        .getShell(input.pullRequest.projectId)
        .pipe(Effect.mapError(failure));
      if (Option.isNone(prProject))
        return yield* failure("The selected PR project is unavailable on this execution host.");
      const reference = { ...input.pullRequest, allowStale: false };
      yield* pullRequests.invalidate({ reference });
      const detail = yield* pullRequests.detail(reference).pipe(
        Effect.mapError(failure),
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(failure("PR context timed out. Retry before inserting.")),
        }),
      );
      if (input.expectedHeadSha && detail.headSha !== input.expectedHeadSha)
        return yield* failure(
          "The PR head changed while preparing this task. Refresh and choose it again.",
        );
      const selected = input.bindingId
        ? resolved.find((entry) => entry.id === input.bindingId)
        : resolved.length === 1
          ? resolved[0]
          : undefined;
      const now = DateTime.formatIso(yield* DateTime.now);
      const built = buildPullRequestActionContext(detail, selected?.repository ?? null, now);
      pr = built.context;
      notices.push(...built.notices);
      if (selected) {
        const identity = yield* identities.resolve(selected.repository.path, { refresh: true });
        const expected =
          `${input.pullRequest.host ?? "github.com"}/${detail.repository}`.toLowerCase();
        if (!identity || identity.canonicalKey.toLowerCase() !== expected) {
          const notice = `Repository mismatch or unverifiable remote identity. Selected ${selected.label} at ${selected.repository.path}; PR ${expected}. Confirm the repository before changing files. No checkout was changed.`;
          notices.push(notice);
          pr = {
            ...pr,
            failures: pr.failures + "\n" + notice,
            conflicts: pr.conflicts + "\n" + notice,
          };
        }
      }
    }
    return {
      threadTitle: projection?.thread.title ?? null,
      workspaceRevision: workspace?.revision ?? null,
      repositories: resolved,
      pullRequest: pr,
      notices,
    };
  });
  return WorkspaceApi.of({
    // Only branch-changing operations reach this guard. They would move a checkout that a
    // multi-repository thread recorded, so the exact checkout is protected, not the repository.
    assertLegacyMutation: (cwd) =>
      Effect.gen(function* () {
        const actual = yield* repositories.inspect(cwd).pipe(Effect.result);
        if (actual._tag === "Failure") return;
        const snapshot = yield* projections
          .getShellSnapshot({ location: "active" })
          .pipe(Effect.mapError(failure));
        const owner = snapshot.threads.find(
          (thread) =>
            thread.workspace &&
            thread.workspace.bindings.length > 1 &&
            thread.workspace.bindings.some(
              (binding) => binding.checkoutPath === actual.success.path,
            ),
        );
        if (owner)
          return yield* failure(
            `This checkout belongs to the multi-repository thread “${owner.title}”. Changing its branch would stop that thread, so use a worktree instead.`,
          );
      }),
    terminalTarget: (input) =>
      Effect.gen(function* () {
        const thread = yield* projections
          .getThreadShell(ThreadId.make(input.threadId))
          .pipe(Effect.mapError(failure));
        if (!thread?.workspace) return null;
        const binding = yield* Effect.try({
          try: () => resolveWorkspaceTerminal(thread.workspace!, input.terminalId),
          catch: failure,
        });
        yield* resolve({
          threadId: thread.id,
          bindingId: binding.id,
          expectedRevision: thread.workspace.revision,
        });
        return { cwd: binding.checkoutPath, worktreePath: null };
      }),
    context,
    status: (input) =>
      resolve(input).pipe(
        Effect.flatMap((binding) =>
          git
            .status({ cwd: binding.checkoutPath })
            .pipe(Effect.map((status) => ({ ...status, repository: binding.repository }))),
        ),
        queries.withPermit,
        Effect.mapError(failure),
      ),
    diff: (input) =>
      resolve(input).pipe(
        Effect.flatMap((binding) =>
          review.getDiffPreview({
            cwd: binding.checkoutPath,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
          }),
        ),
        queries.withPermit,
        Effect.mapError(failure),
      ),
    search: (input) =>
      resolve(input).pipe(
        Effect.flatMap((binding) =>
          entries.search({
            cwd: binding.checkoutPath,
            query: input.query,
            limit: 50,
            kind: "file",
          }),
        ),
        Effect.mapError(failure),
      ),
    writeFile: (input) =>
      commands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const binding = yield* resolve(input, true);
          const normalized = path.normalize(input.relativePath);
          if (
            path.isAbsolute(normalized) ||
            normalized === ".." ||
            normalized.startsWith(".." + path.sep)
          )
            return yield* failure("Select a relative file within this repository.");
          const previous = yield* files
            .readFile({ cwd: binding.checkoutPath, relativePath: normalized })
            .pipe(Effect.mapError(failure));
          if (previous.truncated || previous.contents !== input.expectedContents)
            return yield* failure(
              "This file changed since it was opened or is too large to edit. Reload before saving.",
            );
          return yield* files
            .writeFile({
              cwd: binding.checkoutPath,
              relativePath: normalized,
              contents: input.contents,
            })
            .pipe(Effect.mapError(failure));
        }),
      ),
    readFile: (input) =>
      Effect.gen(function* () {
        const binding = yield* resolve(input);
        const normalized = path.normalize(input.relativePath);
        if (
          path.isAbsolute(normalized) ||
          normalized === ".." ||
          normalized.startsWith(".." + path.sep)
        )
          return yield* failure("Select a relative file within this repository.");
        return yield* files
          .readFile({ cwd: binding.checkoutPath, relativePath: normalized })
          .pipe(Effect.mapError(failure));
      }),
    terminal: (input) =>
      resolve(input).pipe(
        Effect.tap((binding) =>
          input.terminalId.startsWith(`repo:${binding.id}:`)
            ? Effect.void
            : Effect.fail(failure("Use a repository-qualified terminal ID.")),
        ),
        Effect.flatMap((binding) =>
          terminals.open({
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: binding.checkoutPath,
          }),
        ),
        Effect.mapError(failure),
      ),
    gitAction: (input) =>
      commands.withLock(
        input.threadId,
        operations.run(
          input,
          resolve(input, true).pipe(
            Effect.flatMap((binding) =>
              git.runStackedAction({
                actionId: input.actionId,
                cwd: binding.checkoutPath,
                action: input.action,
                ...(input.commitMessage === undefined
                  ? {}
                  : { commitMessage: input.commitMessage }),
                threadId: input.threadId,
                featureBranch: false,
              }),
            ),
            Effect.mapError(failure),
          ),
        ),
      ),
  });
});
export const layer = Layer.effect(WorkspaceApi, make).pipe(
  Layer.provide(Operations.layer),
  Layer.provide(ProjectionStore.layer),
);
