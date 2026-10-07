import { PullRequestRef } from "./pullRequest.ts";
import * as Schema from "effect/Schema";
import {
  CommandId,
  NonNegativeInt,
  ThreadId,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
const PathText = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
export const WorkspaceBindingId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,96}$/));
export const WorkspaceBindingRequest = Schema.Struct({
  id: WorkspaceBindingId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  sourcePath: PathText,
  mode: Schema.Literals(["current", "existing-worktree", "new-worktree"]),
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  branch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type WorkspaceBindingRequest = typeof WorkspaceBindingRequest.Type;
export const WorkspaceRepository = Schema.Struct({
  path: PathText,
  commonDir: PathText,
  gitDir: PathText,
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  dirty: Schema.Boolean,
  operation: Schema.NullOr(Schema.Literals(["merge", "rebase", "cherry-pick", "revert"])),
  unmergedPaths: Schema.Array(Schema.String),
  changes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        index: Schema.String,
        worktree: Schema.String,
        staged: Schema.Boolean,
        unstaged: Schema.Boolean,
        untracked: Schema.Boolean,
        conflicted: Schema.Boolean,
      }),
    ),
  ),
});
export type WorkspaceRepository = typeof WorkspaceRepository.Type;
/** A repository saved as a project's default; new threads in the project start with it. */
export const WorkspaceRepositoryDefault = Schema.Struct({
  path: PathText,
  commonDir: PathText,
  mode: WorkspaceBindingRequest.fields.mode,
});
export type WorkspaceRepositoryDefault = typeof WorkspaceRepositoryDefault.Type;
export const WorkspaceBinding = Schema.Struct({
  ...WorkspaceBindingRequest.fields,
  commonDir: PathText,
  checkoutPath: PathText,
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  baseCommit: Schema.String,
  state: Schema.Literals(["planned", "validating", "preparing", "ready", "failed", "cancelled"]),
  owned: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type WorkspaceBinding = typeof WorkspaceBinding.Type;
/**
 * A project folder that holds repositories rather than being one. The agent starts in
 * `checkoutPath`: the folder itself, or in `mirror` mode a new folder where each
 * repository inside gets a worktree at the same relative path.
 */
export const WorkspaceRootRequest = Schema.Struct({
  sourcePath: PathText,
  mode: Schema.Literals(["current", "mirror"]),
});
export type WorkspaceRootRequest = typeof WorkspaceRootRequest.Type;
export const WorkspaceRoot = Schema.Struct({
  ...WorkspaceRootRequest.fields,
  checkoutPath: PathText,
});
export type WorkspaceRoot = typeof WorkspaceRoot.Type;
export const ThreadWorkspace = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: NonNegativeInt,
  operationId: CommandId,
  state: Schema.Literals(["planned", "validating", "preparing", "ready", "failed", "cancelled"]),
  primaryBindingId: WorkspaceBindingId,
  bindings: Schema.Array(WorkspaceBinding).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  root: Schema.optional(WorkspaceRoot),
});
export type ThreadWorkspace = typeof ThreadWorkspace.Type;
export const WorkspaceConfiguration = Schema.Struct({
  expectedRevision: NonNegativeInt,
  root: Schema.optional(WorkspaceRootRequest),
  primaryBindingId: WorkspaceBindingId,
  bindings: Schema.Array(WorkspaceBindingRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
});
export type WorkspaceConfiguration = typeof WorkspaceConfiguration.Type;
/** The thread has a repository set rather than only its project's own checkout. */
export const hasRepositorySet = (
  workspace: ThreadWorkspace | undefined,
): workspace is ThreadWorkspace =>
  workspace !== undefined && (workspace.bindings.length > 1 || workspace.root !== undefined);
/** Whether this binding is also the thread's own checkout, where turn diffs and the branch toolbar apply. */
export const isThreadCheckoutBinding = (workspace: ThreadWorkspace, bindingId: string) =>
  workspace.root === undefined && bindingId === workspace.primaryBindingId;
export const WorkspaceDiscoverInput = Schema.Struct({
  root: PathText,
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
});
export const WorkspaceDiscoverResult = Schema.Struct({
  repositories: Schema.Array(WorkspaceRepository),
  issues: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  limited: Schema.Boolean,
});
export type WorkspaceDiscoverResult = typeof WorkspaceDiscoverResult.Type;
export const WorkspaceInspectInput = Schema.Struct({ path: PathText });
export const WorkspaceBindingTarget = Schema.Struct({
  threadId: ThreadId,
  bindingId: WorkspaceBindingId,
  expectedRevision: NonNegativeInt,
});
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
export type WorkspaceBindingTarget = typeof WorkspaceBindingTarget.Type;
export const WorkspaceTerminalInput = Schema.Struct({
  ...WorkspaceBindingTarget.fields,
  terminalId: TrimmedNonEmptyString,
});

export const ActionContextInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  bindingId: Schema.optional(WorkspaceBindingId),
  pullRequest: Schema.optional(PullRequestRef),
  expectedHeadSha: Schema.optional(Schema.String),
});
export type ActionContextInput = typeof ActionContextInput.Type;
export const ActionContextResult = Schema.Struct({
  threadTitle: Schema.NullOr(Schema.String),
  workspaceRevision: Schema.NullOr(NonNegativeInt),
  repositories: Schema.Array(
    Schema.Struct({
      id: WorkspaceBindingId,
      label: Schema.String,
      mode: Schema.String,
      repository: WorkspaceRepository,
    }),
  ),
  pullRequest: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      headSha: Schema.NullOr(Schema.String),
      observedAt: Schema.String,
      failures: Schema.String,
      conflicts: Schema.String,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type ActionContextResult = typeof ActionContextResult.Type;
