import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type QuickAction,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { QUICK_ACTION_STARTERS, QUICK_ACTION_STARTER_IDS } from "@t3tools/shared/quickActions";
import {
  describeQuickActionTargets,
  pullRequestSignalStatuses,
  quickActionSignals,
  quickActionTargets,
  renderQuickActionSelection,
  pullRequestTargetKey,
  renderQuickActionText,
  unresolvedReviewThreads,
  type QuickActionVariant,
} from "./quickActionRunner.ts";

const action: QuickAction = {
  id: "paste",
  name: "Paste",
  description: "",
  aliases: [],
  tags: [],
  category: null,
  template: "{{date}} {{clipboard}}",
  projectId: null,
  enabled: true,
  favorite: false,
  autoSend: false,
  revision: 1,
  createdAt: "",
  updatedAt: "",
};
const input = {
  action,
  scope: {
    environmentId: EnvironmentId.make("host"),
    projectId: ProjectId.make("project"),
    thread: null,
  },
  choices: [{}],
  now: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-08T12:00:00")),
  resolveContext: async () => {
    throw new Error("Should not request host context");
  },
};
describe("quick actions across clients", () => {
  it("uses the supplied device clipboard without depending on browser globals", async () => {
    const rendered = await renderQuickActionSelection({
      ...input,
      readClipboard: async () => "phone clipboard",
    });
    expect(rendered.text).toBe("2026-10-08 phone clipboard");
    expect(rendered.contexts).toEqual([]);
  });
  it("does not silently insert an action with a missing clipboard value", async () => {
    await expect(
      renderQuickActionSelection({ ...input, readClipboard: async () => "" }),
    ).rejects.toThrow("clipboard is empty");
  });
});

describe("review thread evidence", () => {
  it("asks the host for review threads only when the template reads them", async () => {
    const requests: unknown[] = [];
    const render = (template: string) =>
      renderQuickActionText({
        ...input,
        action: { ...action, template },
        choice: { pullRequest: { host: "github.com", repository: "acme/app", number: 7 } },
        readClipboard: async () => "",
        resolveContext: async (_environmentId, context) => {
          requests.push(context);
          return {
            threadTitle: null,
            workspaceRevision: null,
            repositories: [],
            pullRequest: {
              url: "https://github.com/acme/app/pull/7",
              headSha: "abc",
              observedAt: "",
              failures: "",
              conflicts: "",
              ...("reviewThreads" in context ? { reviewThreads: "1. src/a.ts:4" } : {}),
            },
            notices: [],
          };
        },
      });
    const rendered = await render("Fix these.\n\n{{pr.reviewThreads}}");
    expect(rendered.text).toBe("Fix these.\n\n1. src/a.ts:4");
    expect(rendered.append).toBe(true);
    await render("Review {{pr.url}}");
    expect(requests.map((request) => "reviewThreads" in (request as object))).toEqual([
      true,
      false,
    ]);
  });
});

describe("CI and merge conflict action availability", () => {
  const ci = QUICK_ACTION_STARTERS.find(
    (entry) => entry.id === QUICK_ACTION_STARTER_IDS.resolveCi,
  )!;
  const conflicts = QUICK_ACTION_STARTERS.find(
    (entry) => entry.id === QUICK_ACTION_STARTER_IDS.resolveConflicts,
  )!;
  type Snapshot = NonNullable<ThreadPullRequestLink["snapshot"]>;
  const link = (
    number: number,
    checksState: Snapshot["checksState"],
    mergeability: Snapshot["mergeability"],
  ) =>
    ({
      host: "github.com",
      repository: `acme/repo-${number}`,
      number,
      snapshot: { state: "open", checksState, mergeability },
    }) as ThreadPullRequestLink;
  const targets = (template: string, pullRequests: ThreadPullRequestLink[]) =>
    quickActionTargets(
      { template },
      { ...input.scope, thread: { pullRequests } as unknown as EnvironmentThreadShell },
    );

  it.each([
    ["passing", "conflicting", "unavailable", "ready"],
    ["failing", "mergeable", "ready", "unavailable"],
    ["failing", "conflicting", "ready", "ready"],
    ["passing", "mergeable", "unavailable", "unavailable"],
    ["pending", "conflicting", "unavailable", "ready"],
  ] as const)(
    "keeps %s CI separate from %s mergeability",
    (checks, mergeability, ciKind, conflictKind) => {
      const links = [link(8, checks, mergeability)];
      expect(targets(ci.template, links).kind).toBe(ciKind);
      expect(targets(conflicts.template, links).kind).toBe(conflictKind);
    },
  );

  it("explains why a passing PR with conflicts cannot run Resolve CI", () => {
    expect(targets(ci.template, [link(8, "passing", "conflicting")])).toEqual({
      kind: "unavailable",
      reason: "No failing CI checks",
    });
    expect(targets(conflicts.template, [link(8, "failing", "mergeable")])).toEqual({
      kind: "unavailable",
      reason: "No merge conflicts",
    });
  });

  it("keeps a PR eligible when the action also reads review threads", () => {
    const links = [link(8, "passing", "mergeable")];
    expect(targets("{{ci.failures}} {{pr.reviewThreads}}", links).kind).toBe("ready");
    expect(targets("{{pr.conflicts}} {{pr.reviewThreads}}", links).kind).toBe("ready");
  });

  it("only selects the repositories that need the chosen action", () => {
    const links = [link(1, "passing", "conflicting"), link(2, "failing", "mergeable")];
    const failing = targets(ci.template, links);
    const conflicting = targets(conflicts.template, links);
    expect(
      failing.kind === "ready" && failing.variants.map((v) => v.choice.pullRequest?.number),
    ).toEqual([2]);
    expect(
      conflicting.kind === "ready" && conflicting.variants.map((v) => v.choice.pullRequest?.number),
    ).toEqual([1]);
    const combined = targets("{{ci.failures}} {{pr.conflicts}}", links);
    expect(combined.kind === "ready" && combined.variants).toHaveLength(2);
    const review = targets("Review {{pr.url}}", links);
    expect(review.kind === "ready" && review.variants).toHaveLength(2);
  });

  it("rules out a PR without checks once fresh state shows it", () => {
    const unsynced = link(8, undefined, "mergeable");
    expect(targets(ci.template, [unsynced]).kind).toBe("ready");
    const fresh = new Map([
      [pullRequestTargetKey(unsynced), { checks: "none", mergeability: "mergeable" } as const],
    ]);
    expect(
      quickActionTargets(
        ci,
        {
          ...input.scope,
          thread: { pullRequests: [unsynced] } as unknown as EnvironmentThreadShell,
        },
        fresh,
      ),
    ).toEqual({ kind: "unavailable", reason: "No failing CI checks" });
  });

  it("says CI is running instead of claiming nothing failed", () => {
    expect(targets(ci.template, [link(8, "pending", "mergeable")])).toEqual({
      kind: "unavailable",
      reason: "CI running, nothing failing yet",
    });
  });

  it("rules out PRs without unresolved review threads once they load", () => {
    const threads = QUICK_ACTION_STARTERS.find(
      (entry) => entry.id === QUICK_ACTION_STARTER_IDS.addressReviewThreads,
    )!;
    const links = [link(1, "passing", "mergeable"), link(2, "passing", "mergeable")];
    const scope = {
      ...input.scope,
      thread: { pullRequests: links } as unknown as EnvironmentThreadShell,
    };
    const fresh = (first: number, second: number, truncated = false) =>
      new Map([
        [pullRequestTargetKey(links[0]!), { reviewThreads: { unresolved: first, truncated } }],
        [pullRequestTargetKey(links[1]!), { reviewThreads: { unresolved: second, truncated } }],
      ]);
    const ready = quickActionTargets(threads, scope, fresh(0, 3));
    expect(
      ready.kind === "ready" && ready.variants.map((v) => v.choice.pullRequest?.number),
    ).toEqual([2]);
    expect(quickActionTargets(threads, scope, fresh(0, 0))).toEqual({
      kind: "unavailable",
      reason: "No unresolved review threads",
    });
    // A truncated list may hide an unresolved thread, so the PR stays eligible.
    expect(quickActionTargets(threads, scope, fresh(0, 0, true)).kind).toBe("ready");
    // Fresh thread counts do not hide the snapshot's CI state.
    const failing = quickActionTargets(ci, scope, fresh(0, 0));
    expect(failing.kind).toBe("unavailable");
  });

  it("keeps unknown states inspectable without treating them as failures", () => {
    const unknown = link(8, undefined, "unknown");
    expect(targets(ci.template, [unknown]).kind).toBe("ready");
    expect(targets(conflicts.template, [unknown]).kind).toBe("ready");
    expect(targets(ci.template, [{ ...unknown, snapshot: null }]).kind).toBe("ready");
    expect(targets("{{ci.failures}} {{pr.conflicts}}", [link(8, "passing", "unknown")]).kind).toBe(
      "ready",
    );
  });
});

describe("base update action availability", () => {
  const rebase = QUICK_ACTION_STARTERS.find(
    (entry) => entry.id === QUICK_ACTION_STARTER_IDS.rebaseOntoBase,
  )!;
  const pullRequest = {
    host: "github.com",
    repository: "acme/repo",
    number: 8,
    snapshot: { state: "open", mergeability: "mergeable" },
  } as ThreadPullRequestLink;
  const targetsWith = (fresh?: { baseComparison: "behind" | "up-to-date"; behindBy?: number }) =>
    quickActionTargets(
      rebase,
      {
        ...input.scope,
        thread: { pullRequests: [pullRequest] } as unknown as EnvironmentThreadShell,
      },
      fresh ? new Map([[pullRequestTargetKey(pullRequest), fresh]]) : undefined,
    );

  it("keeps templates older clients can render and recognizes the starters by ID", () => {
    for (const id of [
      QUICK_ACTION_STARTER_IDS.rebaseOntoBase,
      QUICK_ACTION_STARTER_IDS.mergeBase,
    ]) {
      const starter = QUICK_ACTION_STARTERS.find((entry) => entry.id === id)!;
      expect(starter.template).toContain("{{pr.url}}");
      expect(quickActionSignals(starter)).toEqual(["base"]);
      expect(quickActionSignals({ template: starter.template })).toEqual([]);
    }
  });

  it("offers the update only to a branch the host reports behind its base", () => {
    // The synced snapshot never carries the base comparison, so it stays inspectable.
    expect(targetsWith().kind).toBe("ready");
    expect(targetsWith({ baseComparison: "behind", behindBy: 9 }).kind).toBe("ready");
    expect(targetsWith({ baseComparison: "up-to-date" })).toEqual({
      kind: "unavailable",
      reason: "Already up to date with base",
    });
  });

  it("reports how far the branch is behind", () => {
    const status = (state: Parameters<typeof pullRequestSignalStatuses>[1]) =>
      pullRequestSignalStatuses(["base"], state).map(({ label, tone }) => `${label}:${tone}`);
    expect(status({ baseComparison: "behind", behindBy: 9 })).toEqual([
      "9 commits behind base:alert",
    ]);
    expect(status({ baseComparison: "behind", behindBy: 1 })).toEqual([
      "1 commit behind base:alert",
    ]);
    expect(status({ baseComparison: "up-to-date" })).toEqual(["Up to date with base:ok"]);
    expect(status({})).toEqual(["Base status unknown:unknown"]);
  });
});

describe("quick action target summaries", () => {
  const variant = (
    number: number,
    snapshot: Partial<NonNullable<QuickActionVariant["snapshot"]>> | null,
    bindingId?: string,
  ): QuickActionVariant => ({
    key: `${number}|${bindingId ?? ""}`,
    label: `#${number}`,
    choice: {
      ...(bindingId ? { bindingId } : {}),
      pullRequest: { host: "github.com", repository: "acme/app", number },
    },
    snapshot: snapshot as NonNullable<QuickActionVariant["snapshot"]> | null,
  });
  const fixCi = { template: "Fix {{ci.failures}}" };

  it("counts each pull request once and says how many need the action", () => {
    expect(
      describeQuickActionTargets(fixCi, [
        variant(1, { checksState: "failing" }, "a"),
        variant(1, { checksState: "failing" }, "b"),
        variant(2, { checksState: "passing" }),
        variant(3, { checksState: "failing" }),
      ]),
    ).toBe("2 of 3 pull requests need this");
  });
  it("falls back to the target count when a pull request is not synced", () => {
    expect(
      describeQuickActionTargets(fixCi, [variant(1, { checksState: "failing" }), variant(2, null)]),
    ).toBe("2 pull requests");
  });
  it("counts unresolved review threads across pull requests once they load", () => {
    const threads = { template: "{{pr.reviewThreads}}" };
    const withThreads = (number: number, unresolved: number, truncated = false) => ({
      ...variant(number, null),
      fresh: { reviewThreads: { unresolved, truncated } },
    });
    expect(describeQuickActionTargets(threads, [withThreads(1, 1), withThreads(2, 3)])).toBe(
      "4 unresolved threads in 2 pull requests",
    );
    expect(describeQuickActionTargets(threads, [withThreads(1, 1)])).toBe(
      "1 unresolved thread in 1 pull request",
    );
    expect(describeQuickActionTargets(threads, [withThreads(1, 1, true)])).toBe(
      "1+ unresolved threads in 1 pull request",
    );
    expect(describeQuickActionTargets(threads, [withThreads(1, 1), variant(2, null)])).toBe(
      "2 pull requests",
    );
  });
  it("only counts targets for actions that do not read CI or conflicts", () => {
    expect(
      describeQuickActionTargets({ template: "Review {{pr.url}}" }, [
        variant(1, { checksState: "failing" }),
      ]),
    ).toBe("1 pull request");
  });
});

describe("pull request status per quick action", () => {
  const starter = (id: string) => QUICK_ACTION_STARTERS.find((entry) => entry.id === id)!;
  const conflicting = {
    checks: "none",
    mergeability: "conflicting",
    reviewThreads: { unresolved: 2, truncated: false },
  } as const;
  const statusOf = (id: string) =>
    pullRequestSignalStatuses(quickActionSignals(starter(id)), conflicting).map(
      ({ label, tone }) => `${label}:${tone}`,
    );

  it("shows each starter only the state it acts on", () => {
    expect(statusOf(QUICK_ACTION_STARTER_IDS.resolveConflicts)).toEqual(["Merge conflicts:alert"]);
    expect(statusOf(QUICK_ACTION_STARTER_IDS.resolveCi)).toEqual(["No checks:ok"]);
    expect(statusOf(QUICK_ACTION_STARTER_IDS.addressReviewThreads)).toEqual([
      "2 unresolved threads:alert",
    ]);
    expect(statusOf(QUICK_ACTION_STARTER_IDS.pullRequestWalkthrough)).toEqual([]);
  });

  it("reports review threads for any action that reads them, including imported copies", () => {
    const signals = (id: string, template: string) => quickActionSignals({ id, template });
    expect(signals("imported", "Fix this.\n\n{{pr.reviewThreads}}")).toEqual(["reviewThreads"]);
    expect(signals("imported", "Fix the review feedback on {{pr.url}}.")).toEqual([]);
    // The starter keeps a template older clients can render.
    const starterTemplate = starter(QUICK_ACTION_STARTER_IDS.addressReviewThreads).template;
    expect(starterTemplate).not.toContain("{{pr.reviewThreads}}");
    expect(signals(QUICK_ACTION_STARTER_IDS.addressReviewThreads, starterTemplate)).toEqual([
      "reviewThreads",
    ]);
  });

  it("counts unresolved review threads, including outdated ones", () => {
    const thread = (isResolved: boolean, isOutdated = false) =>
      ({ isResolved, isOutdated }) as never;
    const threads = unresolvedReviewThreads({
      reviewThreads: [thread(true), thread(false, true)],
      reviewThreadsTruncated: false,
    });
    expect(pullRequestSignalStatuses(["reviewThreads"], { reviewThreads: threads })).toEqual([
      { signal: "reviewThreads", label: "1 unresolved thread", tone: "alert" },
    ]);
    expect(
      pullRequestSignalStatuses(["reviewThreads"], {
        reviewThreads: unresolvedReviewThreads({ reviewThreads: [thread(true)] }),
      })[0]?.tone,
    ).toBe("ok");
    expect(
      pullRequestSignalStatuses(["reviewThreads"], {
        reviewThreads: unresolvedReviewThreads(null),
      })[0]?.tone,
    ).toBe("unknown");
  });
});
