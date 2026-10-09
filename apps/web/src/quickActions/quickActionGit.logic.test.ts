import type { ThreadWorkspace, VcsStatusResult, WorkspaceBinding } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  quickActionGitTargets,
  describeQuickActionGit,
  summarizeQuickActionGit,
  resolveQuickActionGit,
  sameQuickActionGit,
} from "@t3tools/client-runtime/quickActionGit";

const status = (overrides: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/test",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  ...overrides,
});

const openPr = {
  number: 1,
  title: "Changes",
  url: "https://github.com/acme/web/pull/1",
  state: "open" as const,
  baseRef: "main",
  headRef: "feature/test",
};

describe("repository quick actions", () => {
  it("names the tracked ref separately from missing base commits", () => {
    const state = status({
      behindCount: 2,
      upstreamRef: "origin/feature/test",
      baseComparison: { ref: "origin/main", aheadCount: 3, behindCount: 4 },
    });
    const repository = {
      cwd: "/repo",
      label: "App",
      unavailable: null,
      status: state,
      action: resolveQuickActionGit(state, false),
    };
    expect(describeQuickActionGit(repository)).toContain(
      "2 commits to pull from origin/feature/test",
    );
    expect(describeQuickActionGit(repository)).toContain("origin/main has 4 commits not here");
    expect(summarizeQuickActionGit([repository]).label).toBe("Pull");
    expect(summarizeQuickActionGit([repository, { ...repository, label: "API" }]).label).toBe(
      "Sync repositories",
    );
  });

  it("does not infer missing base commits from upstream divergence on older servers", () => {
    const state = status({ behindCount: 2 });
    const description = describeQuickActionGit({
      cwd: "/repo",
      label: "App",
      unavailable: null,
      status: state,
      action: resolveQuickActionGit(state, false),
    });
    expect(description).toContain("2 commits to pull from tracked remote branch");
    expect(description).not.toContain("main");
  });

  it("does not offer commit and push while remote commits need integrating", () => {
    expect(
      resolveQuickActionGit(status({ hasWorkingTreeChanges: true, behindCount: 1 }), false)
        .disabled,
    ).toBe(true);
  });
  it("offers the sidebar action independently for repositories in different states", () => {
    const states = [
      status({ behindCount: 2 }),
      status({ aheadCount: 1, pr: openPr }),
      status({ hasWorkingTreeChanges: true, pr: openPr }),
      status({ hasWorkingTreeChanges: true }),
      status({ aheadOfDefaultCount: 1 }),
    ];
    expect(states.map((entry) => resolveQuickActionGit(entry, false).label)).toEqual([
      "Pull",
      "Push",
      "Commit & push",
      "Commit, push & PR",
      "Create PR",
    ]);
  });

  it("uses recorded checkouts and keeps unready bindings unavailable", () => {
    const workspace = {
      bindings: [
        { checkoutPath: "/worktrees/web", label: "web", state: "ready", error: null },
        { checkoutPath: "/worktrees/api", label: "api", state: "failed", error: "Checkout failed" },
      ] as WorkspaceBinding[],
    } as unknown as ThreadWorkspace;
    expect(quickActionGitTargets(workspace, "/parent")).toEqual([
      { cwd: "/worktrees/web", label: "web", unavailable: null },
      { cwd: "/worktrees/api", label: "api", unavailable: "Checkout failed" },
    ]);
    expect(quickActionGitTargets(null, "/worktrees/web")).toEqual([
      { cwd: "/worktrees/web", label: "web", unavailable: null },
    ]);
    expect(quickActionGitTargets(null, null)).toEqual([]);
  });

  it("does not offer a write for unavailable, busy, detached, or diverged repositories", () => {
    for (const entry of [
      null,
      status({ isRepo: false }),
      status({ refName: null }),
      status({ aheadCount: 2, behindCount: 1 }),
    ]) {
      expect(resolveQuickActionGit(entry, false).disabled).toBe(true);
    }
    expect(resolveQuickActionGit(status({ hasWorkingTreeChanges: true }), true).disabled).toBe(
      true,
    );
  });

  it("requires a new choice if refreshing changes the operation or branch", () => {
    const push = resolveQuickActionGit(status({ aheadCount: 1, pr: openPr }), false);
    const createPr = resolveQuickActionGit(status({ aheadCount: 1 }), false);
    expect(sameQuickActionGit(push, createPr, "feature/test", "feature/test")).toBe(false);
    expect(sameQuickActionGit(push, push, "feature/test", "main")).toBe(false);
    expect(sameQuickActionGit(push, push, "feature/test", "feature/test")).toBe(true);
  });
});
