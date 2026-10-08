import { describe, expect, it } from "@effect/vitest";

import type { WorkspaceRepository } from "@t3tools/contracts";

import {
  draftRepositoryFromBinding,
  primaryBindingRequest,
  repositoriesSummary,
  topLevelRepositories,
  workspaceConfiguration,
  type DraftRepository,
} from "./workspaceModel";

const repository = (label: string, mode: DraftRepository["mode"]): DraftRepository => ({
  id: `id-${label}`,
  label,
  path: `/repos/${label}`,
  commonDir: `/repos/${label}/.git`,
  mode,
  branch: "main",
  head: "abc123",
});

describe("workspace configuration", () => {
  it("maps the toolbar's workspace choice onto the primary checkout", () => {
    const base = { label: "web", workspaceRoot: "/repos/web", branch: "main" };
    expect(primaryBindingRequest({ ...base, envMode: "local", worktreePath: null }).mode).toBe(
      "current",
    );
    expect(
      primaryBindingRequest({ ...base, envMode: "worktree", worktreePath: "/wt/web" }),
    ).toMatchObject({ mode: "existing-worktree", sourcePath: "/wt/web" });
    const fresh = primaryBindingRequest({ ...base, envMode: "worktree", worktreePath: null });
    expect(fresh).toMatchObject({ mode: "new-worktree", baseRef: "main" });
    expect(fresh.branch).toMatch(/^t3\/[0-9a-f]{8}$/);
  });

  it.each([true, false])(
    "carries the origin preference %s to new worktrees only",
    (startFromOrigin) => {
      const configuration = workspaceConfiguration({
        primary: primaryBindingRequest({
          label: "web",
          workspaceRoot: "/repos/web",
          branch: "main",
          envMode: "worktree",
          worktreePath: null,
        }),
        repositories: [repository("api", "new-worktree"), repository("local", "current")],
        expectedRevision: 0,
        startFromOrigin,
      });
      expect(configuration.bindings.map((binding) => binding.startFromOrigin)).toEqual([
        startFromOrigin,
        startFromOrigin,
        undefined,
      ]);
    },
  );

  it("preserves an explicit local base when reconfiguring a recorded workspace", () => {
    const recorded = draftRepositoryFromBinding({
      id: "api",
      label: "api",
      sourcePath: "/repos/api",
      commonDir: "/repos/api/.git",
      checkoutPath: "/wt/api",
      mode: "new-worktree",
      branch: "task/api",
      baseRef: "main",
      baseCommit: "abc",
      head: "abc",
      state: "failed",
      owned: true,
      error: "failed",
      startFromOrigin: false,
    });
    const configuration = workspaceConfiguration({
      primary: null,
      repositories: [recorded],
      expectedRevision: 1,
      startFromOrigin: true,
    });
    expect(configuration.bindings[0]?.startFromOrigin).toBe(false);
  });

  it("names bindings after their repositories so worktree folders stay readable", () => {
    const configuration = workspaceConfiguration({
      primary: primaryBindingRequest({
        label: "Web App",
        workspaceRoot: "/repos/web",
        envMode: "local",
        worktreePath: null,
        branch: null,
      }),
      repositories: [repository("api", "new-worktree"), repository("api", "current")],
      expectedRevision: 3,
    });
    expect(configuration.expectedRevision).toBe(3);
    expect(configuration.primaryBindingId).toBe("web-app");
    expect(configuration.bindings.map((binding) => binding.id)).toEqual([
      "web-app",
      "api",
      "api-2",
    ]);
    expect(configuration.bindings[1]).toMatchObject({
      mode: "new-worktree",
      baseRef: "main",
      startFromOrigin: true,
    });
  });

  it("gives a folder's mode to the repositories inside it and keeps the mirror's name free", () => {
    const configuration = workspaceConfiguration({
      primary: null,
      root: { sourcePath: "/repos", mode: "mirror" },
      repositories: [
        repository("web", "current"),
        { ...repository("repos", "current"), path: "/elsewhere/repos" },
      ],
      expectedRevision: 0,
    });
    expect(configuration.root).toEqual({ sourcePath: "/repos", mode: "mirror" });
    expect(configuration.primaryBindingId).toBe("web");
    expect(configuration.bindings.map((binding) => [binding.id, binding.mode])).toEqual([
      ["web", "new-worktree"],
      ["repos-2", "current"],
    ]);
    // A mirrored repository starts from its default branch, not its checkout's branch.
    expect(configuration.bindings[0]).not.toHaveProperty("baseRef");
  });

  it("lists a folder's top-level repositories once each", () => {
    const found = (path: string, commonDir: string, gitDir = commonDir): WorkspaceRepository => ({
      path,
      commonDir,
      gitDir,
      branch: "main",
      head: "abc",
      dirty: false,
      operation: null,
      unmergedPaths: [],
    });
    expect(
      topLevelRepositories([
        found("/org/web-linked", "/org/web/.git", "/org/web/.git/worktrees/linked"),
        found("/org/web/vendor/lib", "/org/web/vendor/lib/.git"),
        found("/org/web", "/org/web/.git"),
        found("/org/api", "/org/api/.git"),
      ]).map((entry) => entry.path),
    ).toEqual(["/org/api", "/org/web"]);
  });

  it("summarizes repositories without listing them all", () => {
    expect(repositoriesSummary(["web"])).toBe("web");
    expect(repositoriesSummary(["web", "api"])).toBe("web + api");
    expect(repositoriesSummary(["web", "api", "sdk"])).toBe("web + 2");
  });
});
