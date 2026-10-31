import { SourceControlProviderKind } from "@t3tools/contracts";
import type { ThreadWorkspace, VcsStatusResult, WorkspaceBinding } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  quickActionGitTargets,
  describeQuickActionGit,
  describeQuickActionGitConfirmations,
  planQuickActionGitBatch,
  quickActionGitRowTitle,
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
  it.each([
    { sourceControlProvider: undefined, shortLabel: "PR" },
    {
      sourceControlProvider: {
        kind: SourceControlProviderKind.make("gitlab"),
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      },
      shortLabel: "MR",
    },
  ])(
    "uses $shortLabel consistently in change-request descriptions",
    ({ sourceControlProvider, shortLabel }) => {
      for (const pr of [null, openPr]) {
        const state = status({ hasWorkingTreeChanges: true, sourceControlProvider, pr });
        const repository = {
          cwd: "/repo",
          label: "App",
          unavailable: null,
          status: state,
          action: resolveQuickActionGit(state, false),
        };
        expect(describeQuickActionGit(repository)).toContain(
          pr ? `${shortLabel} #1 open` : `No open ${shortLabel}`,
        );
        if (!pr) expect(repository.action.label).toBe(`Commit, push & ${shortLabel}`);
      }
    },
  );

  it("does not report idle or busy repositories as needing attention", () => {
    const repositories = [
      { state: status(), busy: false },
      { state: status({ pr: openPr }), busy: false },
      { state: status({ hasUpstream: false, pr: openPr }), busy: false },
      { state: status({ hasUpstream: false }), busy: false },
      { state: status(), busy: true },
    ].map(({ state, busy }, index) => ({
      cwd: `/repo-${index}`,
      label: `App ${index}`,
      unavailable: null,
      status: state,
      action: resolveQuickActionGit(state, busy),
    }));
    // Nothing to choose when every repository is waiting or up to date.
    expect(summarizeQuickActionGit(repositories)).toMatchObject({
      description: "5 repositories · Up to date",
      disabled: true,
    });
    expect(quickActionGitRowTitle(repositories[0]!)).toBe("App 0");
    const pushable = status({ aheadCount: 1, pr: openPr });
    const withWork = [
      ...repositories,
      { ...repositories[0]!, status: pushable, action: resolveQuickActionGit(pushable, false) },
    ];
    expect(summarizeQuickActionGit(withWork)).toMatchObject({
      description: "6 repositories · 1 commit to push",
      disabled: false,
    });
    expect(quickActionGitRowTitle(withWork[5]!)).toBe("App 0: Push");

    const diverged = status({ aheadCount: 1, behindCount: 1 });
    const detached = status({ refName: null });
    const mixed = [
      ...repositories,
      ...[diverged, detached].map((state) => ({
        ...repositories[0]!,
        status: state,
        action: resolveQuickActionGit(state, false),
      })),
      { ...repositories[0]!, unavailable: "Checkout failed" },
    ];
    expect(summarizeQuickActionGit(mixed).description).toContain("3 need attention");
  });

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

  it("plans a batch from each repository's own action and gates its special steps", () => {
    const selection = (label: string, state: VcsStatusResult) => ({
      label,
      status: state,
      action: resolveQuickActionGit(state, false),
    });
    const pull = selection("api", status({ behindCount: 1 }));
    const commit = selection("web", status({ hasWorkingTreeChanges: true }));
    const onDefault = selection(
      "mobile",
      status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }),
    );
    const publish = selection(
      "docs",
      status({ hasUpstream: false, hasPrimaryRemote: false, aheadCount: 1 }),
    );
    expect(publish.action.kind).toBe("open_publish");

    expect(planQuickActionGitBatch([pull, commit])).toEqual({ kind: "run", confirmations: [] });
    const withDefault = planQuickActionGitBatch([pull, onDefault]);
    expect(withDefault).toEqual({ kind: "run", confirmations: [onDefault] });
    if (withDefault.kind === "run")
      expect(describeQuickActionGitConfirmations(withDefault.confirmations)).toBe("mobile (main)");

    expect(planQuickActionGitBatch([publish])).toEqual({ kind: "publish", repository: publish });
    expect(planQuickActionGitBatch([commit, publish])).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("docs"),
    });
  });

  it("requires a new choice if refreshing changes the operation or branch", () => {
    const push = resolveQuickActionGit(status({ aheadCount: 1, pr: openPr }), false);
    const createPr = resolveQuickActionGit(status({ aheadCount: 1 }), false);
    expect(sameQuickActionGit(push, createPr, "feature/test", "feature/test")).toBe(false);
    expect(sameQuickActionGit(push, push, "feature/test", "main")).toBe(false);
    expect(sameQuickActionGit(push, push, "feature/test", "feature/test")).toBe(true);
  });
});
