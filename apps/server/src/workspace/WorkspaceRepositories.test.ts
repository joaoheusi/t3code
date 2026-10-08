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
const advanceOrigin = () => {
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  const localHead = git(repo, "rev-parse", "main");
  const peer = join(root, "peer");
  git(root, "clone", "--branch", "main", remote, peer);
  git(peer, "config", "user.email", "test@example.invalid");
  git(peer, "config", "user.name", "Workspace tests");
  writeFileSync(join(peer, "remote.txt"), "latest remote commit\n");
  git(peer, "add", ".");
  git(peer, "commit", "-m", "advance remote main");
  git(peer, "push", "origin", "main");
  return { remote, peer, localHead, remoteHead: git(peer, "rev-parse", "HEAD") };
};
const newWorktreeConfiguration = (options: { baseRef?: string; startFromOrigin?: boolean }) => ({
  expectedRevision: 0,
  primaryBindingId: "repo",
  bindings: [
    {
      id: "repo",
      label: "repo",
      sourcePath: repo,
      mode: "new-worktree" as const,
      branch: "task/fresh",
      ...options,
    },
  ],
});
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
  it.effect.each(["main", "origin/main", undefined])(
    "starts a new worktree from fresh origin using base %s without moving local main",
    (baseRef) =>
      Effect.gen(function* () {
        const { remoteHead, localHead } = advanceOrigin();
        writeFileSync(join(repo, "file.txt"), "local edits\n");
        yield* run((service) =>
          Effect.gen(function* () {
            const plan = yield* service.plan(
              newWorktreeConfiguration(baseRef ? { baseRef } : {}),
              CommandId.make("fresh-origin"),
            );
            const ready = yield* service.prepare(plan.bindings[0]!, plan.operationId);
            expect(git(ready.checkoutPath, "rev-parse", "HEAD")).toBe(remoteHead);
            expect(git(repo, "rev-parse", "main")).toBe(localHead);
            expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("local edits\n");
          }),
        );
      }),
  );
  it.effect(
    "starts from the default branch and records it when the checkout sits on a stale branch",
    () =>
      Effect.gen(function* () {
        const { remoteHead } = advanceOrigin();
        git(repo, "remote", "set-head", "origin", "main");
        git(repo, "switch", "-c", "stale-feature");
        git(repo, "commit", "--allow-empty", "-m", "unmerged work");
        git(repo, "push", "origin", "stale-feature");
        yield* run((service) =>
          Effect.gen(function* () {
            const plan = yield* service.plan(
              newWorktreeConfiguration({}),
              CommandId.make("default-base"),
            );
            const ready = yield* service.prepare(plan.bindings[0]!, plan.operationId);
            expect(git(ready.checkoutPath, "rev-parse", "HEAD")).toBe(remoteHead);
            expect(git(repo, "config", "--get", "branch.task/fresh.gh-merge-base")).toBe("main");
          }),
        );
      }),
  );
  it.effect("honors an explicit local base even when origin is unavailable", () =>
    Effect.gen(function* () {
      const { localHead, remote } = advanceOrigin();
      rmSync(remote, { recursive: true, force: true });
      yield* run((service) =>
        Effect.gen(function* () {
          const plan = yield* service.plan(
            newWorktreeConfiguration({ baseRef: "main", startFromOrigin: false }),
            CommandId.make("local-base"),
          );
          const ready = yield* service.prepare(plan.bindings[0]!, plan.operationId);
          expect(git(ready.checkoutPath, "rev-parse", "HEAD")).toBe(localHead);
        }),
      );
    }),
  );
  it.effect(
    "fails preparation instead of silently using a stale base when origin cannot be fetched",
    () =>
      Effect.gen(function* () {
        const { remote, localHead } = advanceOrigin();
        rmSync(remote, { recursive: true, force: true });
        yield* run((service) =>
          Effect.gen(function* () {
            const error = yield* service
              .plan(newWorktreeConfiguration({ baseRef: "main" }), CommandId.make("offline"))
              .pipe(Effect.flip);
            expect(error.message).toContain("Git");
            expect(git(repo, "rev-parse", "main")).toBe(localHead);
            expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(
              1,
            );
            expect(git(repo, "branch", "--list", "task/fresh")).toBe("");
          }),
        );
      }),
  );
  it.effect("keeps local-only branches usable when origin has no matching branch", () =>
    Effect.gen(function* () {
      const { localHead } = advanceOrigin();
      git(repo, "branch", "local-only");
      yield* run((service) =>
        Effect.gen(function* () {
          const plan = yield* service.plan(
            newWorktreeConfiguration({ baseRef: "local-only" }),
            CommandId.make("local-only"),
          );
          const ready = yield* service.prepare(plan.bindings[0]!, plan.operationId);
          expect(git(ready.checkoutPath, "rev-parse", "HEAD")).toBe(localHead);
        }),
      );
    }),
  );
  it.effect("pins the fetched base across preparation retries after origin advances again", () =>
    Effect.gen(function* () {
      const { remoteHead, peer } = advanceOrigin();
      yield* run((service) =>
        Effect.gen(function* () {
          const plan = yield* service.plan(
            newWorktreeConfiguration({ baseRef: "main" }),
            CommandId.make("retry"),
          );
          const first = yield* service.prepare(plan.bindings[0]!, plan.operationId);
          git(peer, "commit", "--allow-empty", "-m", "advance again");
          git(peer, "push", "origin", "main");
          git(repo, "fetch", "origin");
          const retry = yield* service.prepare(plan.bindings[0]!, plan.operationId);
          expect(retry.checkoutPath).toBe(first.checkoutPath);
          expect(git(retry.checkoutPath, "rev-parse", "HEAD")).toBe(remoteHead);
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

describe("folder roots", () => {
  const worktree = (id: string, sourcePath: string) => ({
    id,
    label: id,
    sourcePath,
    mode: "new-worktree" as const,
    branch: `task/${id}`,
  });
  it.effect(
    "mirrors repositories at their relative paths and keeps outside ones beside the mirror",
    () =>
      Effect.gen(function* () {
        const folder = join(root, "org");
        const web = init(join(folder, "web"));
        const api = init(join(folder, "services", "api"));
        yield* run((service) =>
          Effect.gen(function* () {
            const plan = yield* service.plan(
              {
                expectedRevision: 0,
                root: { sourcePath: folder, mode: "mirror" },
                primaryBindingId: "web",
                bindings: [worktree("web", web), worktree("api", api), worktree("repo", repo)],
              },
              CommandId.make("mirror"),
            );
            const mirror = plan.root!.checkoutPath;
            expect(NodePath.basename(mirror)).toBe("org");
            expect(plan.bindings.map((binding) => binding.checkoutPath)).toEqual([
              join(mirror, "web"),
              join(mirror, "services", "api"),
              join(NodePath.dirname(mirror), "repo"),
            ]);
            for (const binding of plan.bindings) {
              const ready = yield* service.prepare(binding, plan.operationId);
              expect(git(ready.checkoutPath, "branch", "--show-current")).toBe(binding.branch);
            }
            expect(readFileSync(join(mirror, "services", "api", "file.txt"), "utf8")).toBe(
              "base\n",
            );
          }),
        );
      }),
  );
  it.effect("refuses folder selections it could not mirror or that leave the folder", () =>
    Effect.gen(function* () {
      const folder = join(root, "org");
      const web = init(join(folder, "web"));
      const nested = init(join(web, "nested"));
      yield* run((service) =>
        Effect.gen(function* () {
          const attempt = (
            mode: "current" | "mirror",
            bindings: Parameters<typeof service.plan>[0]["bindings"],
          ) =>
            service
              .plan(
                {
                  expectedRevision: 0,
                  root: { sourcePath: folder, mode },
                  primaryBindingId: bindings[0]!.id,
                  bindings,
                },
                CommandId.make("refused"),
              )
              .pipe(
                Effect.flip,
                Effect.map((error) => error.message),
              );
          expect(
            yield* attempt("mirror", [
              { id: "web", label: "web", sourcePath: web, mode: "current" },
            ]),
          ).toContain("needs a new worktree");
          expect(
            yield* attempt("mirror", [worktree("web", web), worktree("nested", nested)]),
          ).toContain("inside another selected repository");
          expect(yield* attempt("mirror", [worktree("web", web), worktree("org", repo)])).toContain(
            "inside the mirrored folder",
          );
          expect(
            yield* attempt("current", [
              { id: "repo", label: "repo", sourcePath: repo, mode: "current" },
            ]),
          ).toContain("No selected repository is inside");
          const current = yield* service.plan(
            {
              expectedRevision: 0,
              root: { sourcePath: folder, mode: "current" },
              primaryBindingId: "web",
              bindings: [
                { id: "web", label: "web", sourcePath: web, mode: "current" },
                { id: "nested", label: "nested", sourcePath: nested, mode: "current" },
              ],
            },
            CommandId.make("current"),
          );
          expect(current.root).toEqual({
            sourcePath: folder,
            mode: "current",
            checkoutPath: folder,
          });
          expect(current.bindings.map((binding) => binding.checkoutPath)).toEqual([web, nested]);
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
