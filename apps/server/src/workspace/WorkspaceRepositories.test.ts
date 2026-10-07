// @effect-diagnostics nodeBuiltinImport:off - these tests create isolated real Git repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId } from "@t3tools/contracts";
import * as Config from "../config.ts";
import * as Repositories from "./WorkspaceRepositories.ts";
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } =
  NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { execFileSync } = NodeChildProcess;
let root: string;
let repo: string;
const git = (path: string, ...args: string[]) =>
  execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const init = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "user.name", "Workspace tests");
  writeFileSync(join(path, "file.txt"), "base\n");
  git(path, "add", "file.txt");
  git(path, "commit", "-m", "base");
  return path;
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "j4-workspaces-")));
  repo = init(join(root, "repo"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = <A, E>(
  work: (service: Repositories.WorkspaceRepositories["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* work(yield* Repositories.WorkspaceRepositories);
  }).pipe(
    Effect.provide(
      Repositories.layer.pipe(
        Layer.provide(Config.layerTest(root, join(root, "home"))),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

describe("host workspace identity and preparation", () => {
  it.effect(
    "recognizes linked worktrees, deduplicates Git common directories and keeps separate clones",
    () =>
      Effect.gen(function* () {
        const linked = join(root, "linked");
        git(repo, "worktree", "add", "-b", "linked", linked);
        yield* run((service) =>
          Effect.gen(function* () {
            const a = yield* service.inspect(repo);
            const b = yield* service.inspect(linked);
            expect(a.commonDir).toBe(b.commonDir);
            expect(b.path).toBe(linked);
            const error = yield* service
              .plan(
                {
                  expectedRevision: 0,
                  primaryBindingId: "a",
                  bindings: [
                    { id: "a", label: "A", sourcePath: repo, mode: "current" },
                    { id: "b", label: "B", sourcePath: linked, mode: "existing-worktree" },
                  ],
                },
                CommandId.make("op"),
              )
              .pipe(Effect.flip);
            expect(error.message).toContain("one checkout");
            const clone = join(root, "clone");
            execFileSync("git", ["clone", repo, clone], { stdio: "pipe" });
            expect(
              (yield* service.plan(
                {
                  expectedRevision: 0,
                  primaryBindingId: "a",
                  bindings: [
                    { id: "a", label: "A", sourcePath: repo, mode: "current" },
                    { id: "c", label: "C", sourcePath: clone, mode: "current" },
                  ],
                },
                CommandId.make("op-clone"),
              )).bindings,
            ).toHaveLength(2);
          }),
        );
      }),
  );
  it.effect(
    "discovers nested repositories without following symlinks or dependency directories",
    () =>
      Effect.gen(function* () {
        init(join(repo, "nested"));
        init(join(root, "node_modules", "hidden"));
        const outside = init(join(root, "outside"));
        symlinkSync(outside, join(repo, "escape"));
        yield* run((service) =>
          Effect.gen(function* () {
            const result = yield* service.discover(repo, 3);
            expect(result.repositories.map((entry) => entry.path)).toEqual([
              repo,
              join(repo, "nested"),
            ]);
            expect(result.issues.some((issue) => issue.path.endsWith("escape"))).toBe(true);
            const bounded = yield* service.discover(repo, 0);
            expect(bounded.limited).toBe(true);
          }),
        );
      }),
  );
  it.effect(
    "creates from a resolved commit, preserves dirty files, and adopts one matching result after lost completion",
    () =>
      Effect.gen(function* () {
        writeFileSync(join(repo, "file.txt"), "user changes\n");
        yield* run((service) =>
          Effect.gen(function* () {
            const plan = yield* service.plan(
              {
                expectedRevision: 0,
                primaryBindingId: "a",
                bindings: [
                  {
                    id: "a",
                    label: "A",
                    sourcePath: repo,
                    mode: "new-worktree",
                    baseRef: "main",
                    branch: "task/one",
                  },
                ],
              },
              CommandId.make("crash-op"),
            );
            const first = yield* service.prepare(plan.bindings[0]!, plan.operationId);
            const adopted = yield* service.prepare(plan.bindings[0]!, plan.operationId);
            expect(adopted.checkoutPath).toBe(first.checkoutPath);
            expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(
              2,
            );
            expect(git(repo, "diff")).toContain("user changes");
            expect(git(first.checkoutPath, "status", "--porcelain")).toBe("");
          }),
        );
      }),
  );
  it.effect("never adopts or deletes an unknown directory at an expected worktree path", () =>
    Effect.gen(function* () {
      yield* run((service) =>
        Effect.gen(function* () {
          const plan = yield* service.plan(
            {
              expectedRevision: 0,
              primaryBindingId: "a",
              bindings: [
                {
                  id: "a",
                  label: "A",
                  sourcePath: repo,
                  mode: "new-worktree",
                  baseRef: "main",
                  branch: "task/collision",
                },
              ],
            },
            CommandId.make("occupied"),
          );
          const binding = plan.bindings[0]!;
          mkdirSync(binding.checkoutPath, { recursive: true });
          writeFileSync(join(binding.checkoutPath, "keep.txt"), "unowned");
          const failure = yield* service.prepare(binding, plan.operationId).pipe(Effect.flip);
          expect(failure.message).toContain("unowned");
          expect(readFileSync(join(binding.checkoutPath, "keep.txt"), "utf8")).toBe("unowned");
          expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(
            1,
          );
        }),
      );
    }),
  );
  it.effect("blocks continuation only when preparation is incomplete or a checkout is gone", () =>
    Effect.gen(function* () {
      yield* run((service) =>
        Effect.gen(function* () {
          const plan = yield* service.plan(
            {
              expectedRevision: 0,
              primaryBindingId: "a",
              bindings: [{ id: "a", label: "A", sourcePath: repo, mode: "current" }],
            },
            CommandId.make("resume"),
          );
          expect((yield* service.validate(plan).pipe(Effect.flip)).message).toContain("incomplete");
          const binding = yield* service.prepare(plan.bindings[0]!, plan.operationId);
          const ready = { ...plan, state: "ready" as const, bindings: [binding] };
          yield* service.validate(ready);
          git(repo, "switch", "-c", "changed");
          yield* service.validate(ready);
          rmSync(repo, { recursive: true, force: true });
          expect((yield* service.validate(ready).pipe(Effect.flip)).message).toContain("missing");
        }),
      );
    }),
  );
});

describe("Git change categories", () => {
  it("keeps staging, unstaged work, untracked files, conflicts and rename destinations distinct", () => {
    const changes = Repositories.parseWorkspaceChanges(
      "M  staged.txt\0 M unstaged.txt\0MM both.txt\0?? untracked.txt\0UU conflict.txt\0R  renamed to.txt\0old name.txt\0",
    );
    expect(changes.map((file) => file.path)).toEqual([
      "staged.txt",
      "unstaged.txt",
      "both.txt",
      "untracked.txt",
      "conflict.txt",
      "renamed to.txt",
    ]);
    expect(changes[0]).toMatchObject({ staged: true, unstaged: false });
    expect(changes[1]).toMatchObject({ staged: false, unstaged: true });
    expect(changes[2]).toMatchObject({ staged: true, unstaged: true });
    expect(changes[3]).toMatchObject({ untracked: true, staged: false });
    expect(changes[4]).toMatchObject({ conflicted: true });
  });
});
