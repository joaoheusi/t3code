import * as Semaphore from "effect/Semaphore";
import { expandHomePath } from "../pathExpansion.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  WorkspaceError,
  type WorkspaceRepository,
  type WorkspaceDiscoverResult,
  type WorkspaceBinding,
  type WorkspaceConfiguration,
  type ThreadWorkspace,
  type CommandId,
} from "@t3tools/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
const excluded = new Set([
  ".git",
  "node_modules",
  ".pnpm",
  ".yarn",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "dist",
  "build",
  "vendor",
  "target",
  "Library",
]);
const fail = (detail: string) => new WorkspaceError({ detail });
export class WorkspaceRepositories extends Context.Service<
  WorkspaceRepositories,
  {
    /** The real absolute path, with `~` expanded and symlinks resolved. */
    readonly canonical: (path: string) => Effect.Effect<string, WorkspaceError>;
    readonly inspect: (path: string) => Effect.Effect<WorkspaceRepository, WorkspaceError>;
    readonly discover: (
      root: string,
      depth: number,
    ) => Effect.Effect<WorkspaceDiscoverResult, WorkspaceError>;
    readonly plan: (
      input: WorkspaceConfiguration,
      operationId: CommandId,
    ) => Effect.Effect<ThreadWorkspace, WorkspaceError>;
    readonly prepare: (
      binding: WorkspaceBinding,
      operationId: CommandId,
    ) => Effect.Effect<WorkspaceBinding, WorkspaceError>;
    readonly validate: (workspace: ThreadWorkspace) => Effect.Effect<void, WorkspaceError>;
  }
>()("t3/workspace/WorkspaceRepositories") {}
export function parseWorkspaceChanges(output: string) {
  const records = output.split("\0");
  const changes: NonNullable<WorkspaceRepository["changes"]>[number][] = [];
  for (let i = 0; i < records.length; i++) {
    const entry = records[i]!;
    if (entry.length < 4) continue;
    const index = entry[0]!,
      worktree = entry[1]!;
    const untracked = index === "?" && worktree === "?";
    const conflicted =
      index === "U" || worktree === "U" || index + worktree === "AA" || index + worktree === "DD";
    changes.push({
      path: entry.slice(3),
      index,
      worktree,
      staged: !untracked && index !== " " && index !== "!",
      unstaged: !untracked && worktree !== " " && worktree !== "!",
      untracked,
      conflicted,
    });
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") i++;
  }
  return changes;
}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { basename, isAbsolute, join, relative, resolve } = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const permits = yield* Semaphore.make(4);
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const canonical = (input: string) =>
    Effect.gen(function* () {
      const path = expandHomePath(input);
      if (!isAbsolute(path)) return yield* fail("Enter an absolute path on this execution host.");
      return yield* fs
        .realPath(path)
        .pipe(Effect.mapError(() => fail(`The path is missing or unreadable: ${path}`)));
    });
  /** Whether `child` is strictly inside `parent`; both must already be canonical. */
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return (
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(".." + (platform === "win32" ? "\\" : "/")) &&
      !isAbsolute(rel)
    );
  };
  const git = (cwd: string, args: readonly string[]) =>
    runner
      .run({
        command: "git",
        args: ["--no-optional-locks", "-C", cwd, ...args],
        timeout: "10 seconds",
        maxOutputBytes: 262144,
        outputMode: "error",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
      .pipe(
        permits.withPermit,
        Effect.mapError(() => fail(`Git could not inspect ${cwd}.`)),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                fail(`Git rejected the operation in ${cwd}: ${result.stderr.slice(0, 2048)}`),
              ),
        ),
      );
  const inspect: WorkspaceRepositories["Service"]["inspect"] = Effect.fn(
    "WorkspaceRepositories.inspect",
  )(function* (path) {
    const requested = yield* canonical(path);
    const root = (yield* git(requested, ["rev-parse", "--show-toplevel"])).trim();
    const checkout = yield* canonical(root);
    const commonDir = yield* canonical(
      (yield* git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
    );
    const gitDir = yield* canonical(
      (yield* git(checkout, ["rev-parse", "--absolute-git-dir"])).trim(),
    );
    const head = (yield* git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const branch = (yield* git(checkout, ["branch", "--show-current"])).trim() || null;
    const changes = parseWorkspaceChanges(
      yield* git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    );
    const dirty = changes.length > 0;
    const unmergedPaths = (yield* git(checkout, ["diff", "--name-only", "--diff-filter=U", "-z"]))
      .split("\0")
      .filter(Boolean);
    let operation: WorkspaceRepository["operation"] = null;
    for (const [file, name] of [
      ["MERGE_HEAD", "merge"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const)
      if (
        yield* fs
          .exists(join(gitDir, file))
          .pipe(Effect.mapError(() => fail("Cannot inspect the Git operation.")))
      ) {
        operation = name;
        break;
      }
    return {
      path: checkout,
      commonDir,
      gitDir,
      branch,
      head,
      dirty,
      operation,
      unmergedPaths,
      changes,
    };
  });
  const discover: WorkspaceRepositories["Service"]["discover"] = Effect.fn(
    "WorkspaceRepositories.discover",
  )(function* (root, depth) {
    if (!Number.isInteger(depth) || depth < 0 || depth > 5)
      return yield* fail("Discovery depth must be between 0 and 5.");
    const started = yield* Clock.currentTimeMillis;
    const approved = yield* canonical(root);
    const queue = [{ path: approved, level: 0 }];
    const seen = new Set<string>();
    const repositories: WorkspaceRepository[] = [];
    const issues: { path: string; reason: string }[] = [];
    let visited = 0;
    let limited = false;
    while (queue.length) {
      if ((yield* Clock.currentTimeMillis) - started >= 30000) {
        limited = true;
        issues.push({ path: approved, reason: "Discovery reached its 30-second time limit" });
        break;
      }
      if (visited++ >= 2000 || repositories.length >= 100) {
        limited = true;
        break;
      }
      const next = queue.shift()!;
      const actual = yield* canonical(next.path).pipe(Effect.catch(() => Effect.succeed(null)));
      if (actual === null) {
        issues.push({ path: next.path, reason: "Unreadable or missing" });
        continue;
      }
      const rel = relative(approved, actual);
      if (
        rel === ".." ||
        rel.startsWith(`..${platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(rel) ||
        seen.has(actual)
      ) {
        issues.push({
          path: next.path,
          reason: "Symlink, duplicate, or outside the approved root",
        });
        continue;
      }
      seen.add(actual);
      // Skip symlink targets even inside the root; explicit paths remain available.
      if (resolve(next.path) !== actual) {
        issues.push({ path: next.path, reason: "Symlink skipped; select it explicitly if needed" });
        continue;
      }
      const info = yield* fs.stat(actual).pipe(Effect.catch(() => Effect.succeed(null)));
      if (info?.type !== "Directory") continue;
      const repository = (yield* fs
        .exists(join(actual, ".git"))
        .pipe(Effect.orElseSucceed(() => false)))
        ? yield* inspect(actual).pipe(Effect.catch(() => Effect.succeed(null)))
        : null;
      if (repository?.path === actual && !repositories.some((entry) => entry.path === actual))
        repositories.push(repository);
      if (next.level >= depth) {
        if (
          (yield* fs.readDirectory(actual).pipe(Effect.catch(() => Effect.succeed([])))).some(
            (name) => !excluded.has(name),
          )
        )
          limited = true;
        continue;
      }
      const names = yield* fs.readDirectory(actual).pipe(
        Effect.catch(() => {
          issues.push({ path: actual, reason: "Unreadable directory" });
          return Effect.succeed([]);
        }),
      );
      for (const name of names.toSorted()) {
        if (excluded.has(name)) continue;
        if (queue.length + visited >= 2000) {
          limited = true;
          break;
        }
        queue.push({ path: join(actual, name), level: next.level + 1 });
      }
    }
    return { repositories, issues, limited };
  });
  const plan: WorkspaceRepositories["Service"]["plan"] = Effect.fn("WorkspaceRepositories.plan")(
    function* (input, operationId) {
      const ids = new Set<string>();
      const identities = new Set<string>();
      const bindings: WorkspaceBinding[] = [];
      const safeOperation = Buffer.from(operationId).toString("hex");
      if (safeOperation.length > 256) return yield* fail("The operation ID is too long.");
      const operationDir = join(config.worktreesDir, "workspace", safeOperation);
      const rootPath = input.root ? yield* canonical(input.root.sourcePath) : null;
      // A mirror keeps the folder's name, so paths the agent reads still look like the project.
      const mirrorPath =
        rootPath && input.root?.mode === "mirror"
          ? join(operationDir, basename(rootPath) || "folder")
          : null;
      for (const request of input.bindings) {
        if (ids.has(request.id))
          return yield* fail("Each repository binding must have a unique ID.");
        ids.add(request.id);
        const repository = yield* inspect(request.sourcePath);
        if (identities.has(repository.commonDir))
          return yield* fail(
            `Only one checkout from ${repository.commonDir} can be active in a thread.`,
          );
        identities.add(repository.commonDir);
        const insideRoot = rootPath !== null && contains(rootPath, repository.path);
        if (mirrorPath && insideRoot && request.mode !== "new-worktree")
          return yield* fail(
            `${request.label} is inside the mirrored folder, so it needs a new worktree.`,
          );
        let checkoutPath = repository.path;
        let baseCommit = repository.head;
        let branch = repository.branch;
        let baseBranch: string | null = null;
        if (request.mode === "new-worktree") {
          if (!request.branch) return yield* fail("A new worktree requires a branch.");
          yield* git(repository.path, ["check-ref-format", "--branch", request.branch]);
          // Without a chosen base, start from the default branch: the source checkout may
          // sit on a stale feature branch the user never sees in this flow.
          const defaultBranch = request.baseRef
            ? null
            : yield* gitDriver
                .resolveDefaultBranchName(repository.path, "origin")
                .pipe(Effect.orElseSucceed(() => null));
          let startRef = request.baseRef ?? defaultBranch ?? repository.branch ?? repository.head;
          if (
            request.startFromOrigin !== false &&
            (yield* gitDriver
              .remoteExists({ cwd: repository.path, remoteName: "origin" })
              .pipe(Effect.mapError((cause) => fail(cause.message))))
          ) {
            yield* gitDriver
              .fetchRemote({
                cwd: repository.path,
                remoteName: "origin",
                refName: startRef,
              })
              .pipe(Effect.mapError((cause) => fail(cause.message)));
            if (
              yield* gitDriver
                .remoteBranchExists({
                  cwd: repository.path,
                  remoteName: "origin",
                  refName: startRef,
                })
                .pipe(Effect.mapError((cause) => fail(cause.message)))
            ) {
              baseBranch = startRef;
              startRef = (yield* gitDriver
                .resolveRemoteTrackingCommit({
                  cwd: repository.path,
                  refName: startRef,
                  fallbackRemoteName: "origin",
                })
                .pipe(Effect.mapError((cause) => fail(cause.message)))).commitSha;
            }
          }
          baseBranch ??= (yield* git(repository.path, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${startRef}`,
          ]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ))
            ? startRef
            : null;
          // A default branch without a local copy still has the cached remote-tracking ref.
          if (baseBranch === null && startRef === defaultBranch) {
            baseBranch = defaultBranch;
            startRef = `refs/remotes/origin/${defaultBranch}`;
          }
          // Persist the fetched commit so retries keep the same base even if origin moves.
          baseCommit = (yield* git(repository.path, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${startRef}^{commit}`,
          ])).trim();
          checkoutPath =
            mirrorPath && insideRoot
              ? join(mirrorPath, relative(rootPath!, repository.path))
              : join(operationDir, request.id);
          if (
            mirrorPath &&
            !insideRoot &&
            (checkoutPath === mirrorPath || contains(mirrorPath, checkoutPath))
          )
            return yield* fail(
              `${request.label} would land inside the mirrored folder. Give it another ID.`,
            );
          branch = request.branch;
        }
        const { baseRef: _requestedBase, ...rest } = request;
        bindings.push({
          ...rest,
          // Only a branch name is kept, since preparation records it as the diff base.
          ...(baseBranch ? { baseRef: baseBranch } : {}),
          sourcePath: repository.path,
          commonDir: repository.commonDir,
          checkoutPath,
          branch,
          head: repository.head,
          baseCommit,
          state: "planned",
          owned: request.mode === "new-worktree",
          error: null,
        });
      }
      if (!ids.has(input.primaryBindingId))
        return yield* fail("Select a primary repository from the workspace.");
      if (rootPath !== null) {
        const inside = bindings.filter((binding) => contains(rootPath, binding.sourcePath));
        if (inside.length === 0)
          return yield* fail(`No selected repository is inside ${rootPath}.`);
        // A worktree can't hold another repository's worktree.
        const nested = mirrorPath
          ? inside.find((binding) =>
              inside.some((other) => contains(other.sourcePath, binding.sourcePath)),
            )
          : undefined;
        if (nested)
          return yield* fail(
            `${nested.label} is inside another selected repository, so the folder can't be mirrored. Remove one of them.`,
          );
      }
      return {
        schemaVersion: 1,
        revision: input.expectedRevision + 1,
        operationId,
        state: "planned",
        primaryBindingId: input.primaryBindingId,
        bindings,
        ...(rootPath !== null
          ? {
              root: {
                sourcePath: rootPath,
                mode: input.root!.mode,
                checkoutPath: mirrorPath ?? rootPath,
              },
            }
          : {}),
      };
    },
  );
  const markerSchema = Schema.Struct({
    operationId: Schema.String,
    bindingId: Schema.String,
    commonDir: Schema.String,
    path: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
  });
  const prepare: WorkspaceRepositories["Service"]["prepare"] = Effect.fn(
    "WorkspaceRepositories.prepare",
  )(function* (binding, operationId) {
    if (binding.mode === "new-worktree") {
      const source = yield* inspect(binding.sourcePath);
      if (source.commonDir !== binding.commonDir)
        return yield* fail(
          "The repository moved or its Git identity changed. Reconfigure this binding.",
        );
      const marker = join(
        binding.commonDir,
        "j4code-workspace-ownership",
        `${Buffer.from(operationId).toString("hex")}-${binding.id}.json`,
      );
      const ownership = {
        operationId,
        bindingId: binding.id,
        commonDir: binding.commonDir,
        path: binding.checkoutPath,
        branch: binding.branch!,
        commit: binding.baseCommit,
      };
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(markerSchema))(ownership).pipe(
        Effect.mapError(() => fail("Could not encode worktree ownership.")),
      );
      yield* fs
        .makeDirectory(join(binding.commonDir, "j4code-workspace-ownership"), { recursive: true })
        .pipe(Effect.mapError(() => fail("Could not record worktree ownership.")));
      const existing = yield* fs
        .readFileString(marker)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (existing !== null && existing !== text)
        return yield* fail(
          "This operation's ownership marker does not match. No checkout was changed.",
        );
      if (
        existing === null &&
        (yield* fs
          .exists(binding.checkoutPath)
          .pipe(Effect.mapError(() => fail("Cannot inspect the destination."))))
      )
        return yield* fail(
          "An unowned checkout path already exists. Choose another operation or repair it explicitly.",
        );
      if (existing === null)
        yield* fs
          .writeFileString(marker, text, { flag: "wx" })
          .pipe(Effect.mapError(() => fail("Could not exclusively record worktree ownership.")));
      if (
        !(yield* fs
          .exists(binding.checkoutPath)
          .pipe(Effect.mapError(() => fail("Cannot inspect the worktree path."))))
      ) {
        yield* fs
          .makeDirectory(join(binding.checkoutPath, ".."), { recursive: true })
          .pipe(Effect.mapError(() => fail("Could not create the managed worktree parent.")));
        const managedRoot = yield* canonical(config.worktreesDir);
        const actualParent = yield* canonical(join(binding.checkoutPath, ".."));
        const parentRelative = relative(managedRoot, actualParent);
        if (
          parentRelative === ".." ||
          parentRelative.startsWith(".." + (platform === "win32" ? "\\" : "/")) ||
          isAbsolute(parentRelative)
        )
          return yield* fail(
            "The managed worktree parent resolves outside this fork's worktree directory.",
          );
        yield* git(source.path, [
          "worktree",
          "add",
          "-b",
          binding.branch!,
          "--",
          binding.checkoutPath,
          binding.baseCommit,
        ]);
      }
      // Like single-repository worktrees, so the changes count compares with this base.
      if (binding.baseRef)
        yield* git(source.path, [
          "config",
          `branch.${binding.branch!}.gh-merge-base`,
          binding.baseRef,
        ]);
    }
    const actual = yield* inspect(binding.checkoutPath);
    if (
      actual.path !== binding.checkoutPath ||
      actual.commonDir !== binding.commonDir ||
      actual.branch !== binding.branch ||
      (binding.mode === "new-worktree" && actual.head !== binding.baseCommit) ||
      actual.operation !== null
    )
      return yield* fail(
        "The checkout identity, branch, commit, or active Git operation differs from the recorded workspace. Repair it before continuing.",
      );
    return { ...binding, head: actual.head, state: "ready", error: null };
  });
  const validate: WorkspaceRepositories["Service"]["validate"] = Effect.fn(
    "WorkspaceRepositories.validate",
  )(function* (workspace) {
    if (
      workspace.state !== "ready" ||
      workspace.bindings.some((binding) => binding.state !== "ready")
    )
      return yield* fail(
        "Workspace preparation is incomplete. Retry or reconfigure the failed repositories before sending.",
      );
    // Only identity is enforced: the agent may switch branches or resolve a merge in place,
    // but a checkout that vanished or became another repository must never be substituted.
    for (const binding of workspace.bindings) {
      const actual = yield* inspect(binding.checkoutPath);
      if (actual.path !== binding.checkoutPath || actual.commonDir !== binding.commonDir)
        return yield* fail(
          `Repository ${binding.label} is missing or is no longer the same repository at ${binding.checkoutPath}. Restore it before continuing.`,
        );
    }
  });
  return WorkspaceRepositories.of({ canonical, inspect, discover, plan, prepare, validate });
});
import * as Schema from "effect/Schema";
export const layer = Layer.effect(WorkspaceRepositories, make).pipe(
  Layer.provide(Layer.merge(ProcessRunner.layer, GitVcsDriver.layer)),
);
