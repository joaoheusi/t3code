import type { PullRequestCheck, PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
  pullRequestSnapshotMergeState,
  quickActionMergeActionInput,
  quickActionMergeKind,
} from "./pullRequestActions.ts";

const check = (status: PullRequestCheck["status"], required?: boolean): PullRequestCheck => ({
  name: `check-${status}-${required}`,
  status,
  description: null,
  url: null,
  ...(required === undefined ? {} : { required }),
});
const detail = (overrides: Partial<PullRequestDetail> = {}) =>
  ({
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    checks: [check("success")],
    capabilities: { actions: ["merge"], mergeMethods: ["merge", "squash"] },
    viewerPermissions: { actions: ["merge"] },
    mergeCapabilities: { merge: true, squash: true, rebase: false },
    ...overrides,
  }) as PullRequestDetail;

describe("pullRequestMergeBlocker", () => {
  it("names what blocks a fresh detail", () => {
    const cases: Array<[Partial<PullRequestDetail>, string | null]> = [
      [{}, null],
      [{ checks: [] }, null],
      [{ state: "merged" }, "Already merged"],
      [{ state: "closed" }, "Closed"],
      [{ mergeability: "conflicting", isDraft: true }, "Has merge conflicts"],
      [{ isDraft: true, checks: [check("failure")] }, "Still a draft"],
      [{ checks: [check("pending"), check("failure")] }, "Required checks failing"],
      [{ checks: [check("success"), check("pending")] }, "Waiting for CI"],
      [
        { viewerPermissions: { actions: [] } as unknown as PullRequestDetail["viewerPermissions"] },
        "You can't merge this pull request",
      ],
      [
        { mergeCapabilities: { merge: false, squash: false, rebase: false } },
        "You can't merge this pull request",
      ],
      [{ checks: [check("pending")], autoMergeEnabled: true }, "Auto-merge is on"],
    ];
    for (const [overrides, reason] of cases) {
      expect(pullRequestMergeBlocker(pullRequestDetailMergeState(detail(overrides)))).toBe(reason);
    }
  });

  it("gates on required checks where the host marks them, like GitHub", () => {
    const blocker = (checks: PullRequestCheck[]) =>
      pullRequestMergeBlocker(pullRequestDetailMergeState(detail({ checks })));
    expect(blocker([check("failure", false), check("pending", false)])).toBeNull();
    expect(blocker([check("failure", false), check("pending", true)])).toBe("Waiting for CI");
    expect(blocker([check("success", true), check("failure", true)])).toBe(
      "Required checks failing",
    );
    // A host that marks no check keeps every check as a gate.
    expect(blocker([check("failure")])).toBe("Required checks failing");
  });

  it("never blocks on a snapshot's all-checks state", () => {
    expect(
      pullRequestMergeBlocker(
        pullRequestSnapshotMergeState({ state: "open", isDraft: false, mergeability: "mergeable" }),
      ),
    ).toBeNull();
    expect(
      pullRequestMergeBlocker(
        pullRequestSnapshotMergeState({ state: "open", isDraft: true, mergeability: "unknown" }),
      ),
    ).toBe("Still a draft");
  });

  it("does not block on what a synced snapshot leaves unknown", () => {
    expect(pullRequestMergeBlocker({ state: "open", isDraft: false })).toBeNull();
    expect(
      pullRequestMergeBlocker({
        state: "open",
        isDraft: false,
        mergeability: "unknown",
        checksState: null,
      }),
    ).toBeNull();
    expect(pullRequestMergeBlocker({ state: "open", isDraft: false, checksState: "pending" })).toBe(
      "Waiting for CI",
    );
  });
});

describe("quickActionMergeKind", () => {
  const autoMerge = {
    capabilities: {
      actions: ["merge", "enable-auto-merge"],
      mergeMethods: ["merge", "squash"],
    } as unknown as PullRequestDetail["capabilities"],
    viewerPermissions: {
      actions: ["merge", "enable-auto-merge"],
    } as unknown as PullRequestDetail["viewerPermissions"],
  };
  const kind = (overrides: Partial<PullRequestDetail>) =>
    quickActionMergeKind(pullRequestDetailMergeState(detail(overrides)));

  it("merges a clean PR and arms auto-merge while required checks run", () => {
    expect(kind({})).toBe("merge");
    expect(kind({ ...autoMerge, checks: [check("pending")], autoMergeEnabled: false })).toBe(
      "auto-merge",
    );
  });

  it("starts nothing it cannot finish", () => {
    // Unknown auto-merge state is not "off": arming twice is a write nobody asked for.
    expect(kind({ ...autoMerge, checks: [check("pending")] })).toBeNull();
    expect(kind({ ...autoMerge, checks: [check("pending")], autoMergeEnabled: true })).toBeNull();
    expect(kind({ checks: [check("pending")], autoMergeEnabled: false })).toBeNull();
    expect(kind({ ...autoMerge, checks: [check("failure")], autoMergeEnabled: false })).toBeNull();
    expect(
      kind({
        ...autoMerge,
        checks: [check("pending")],
        autoMergeEnabled: false,
        mergeability: "conflicting",
      }),
    ).toBeNull();
  });

  it("refuses in the write lane when the PR no longer starts the same way", () => {
    const input = quickActionMergeActionInput({
      reference: { repository: "acme/web", number: 1 },
      kind: "auto-merge",
      method: "squash",
    });
    expect(input.action).toBe("enable-auto-merge");
    expect(
      input.resolveMergeMethod(
        detail({ ...autoMerge, checks: [check("pending")], autoMergeEnabled: false }),
      ),
    ).toBe("squash");
    // CI finished between the choice and the write: arming now would be the wrong action.
    expect(() =>
      input.resolveMergeMethod(detail({ ...autoMerge, autoMergeEnabled: false })),
    ).toThrow("Review it again");
  });
});
