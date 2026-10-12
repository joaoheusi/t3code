import type { PullRequestCheck, PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
  resolveThreadPanelPullRequestAction,
} from "./pullRequestActions.ts";

const check = (status: PullRequestCheck["status"]): PullRequestCheck => ({
  name: `check-${status}`,
  status,
  description: null,
  url: null,
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
  it("blocks a detail exactly when the thread panel withholds Merge", () => {
    const cases: Array<[Partial<PullRequestDetail>, string | null]> = [
      [{}, null],
      [{ checks: [] }, null],
      [{ state: "merged" }, "Already merged"],
      [{ state: "closed" }, "Closed"],
      [{ mergeability: "conflicting", isDraft: true }, "Has merge conflicts"],
      [{ isDraft: true, checks: [check("failure")] }, "Still a draft"],
      [{ checks: [check("pending"), check("failure")] }, "CI failing"],
      [{ checks: [check("success"), check("pending")] }, "Waiting for CI"],
      [
        { viewerPermissions: { actions: [] } as unknown as PullRequestDetail["viewerPermissions"] },
        "You can't merge this pull request",
      ],
      [
        { mergeCapabilities: { merge: false, squash: false, rebase: false } },
        "You can't merge this pull request",
      ],
    ];
    for (const [overrides, reason] of cases) {
      const pullRequest = detail(overrides);
      expect(pullRequestMergeBlocker(pullRequestDetailMergeState(pullRequest))).toBe(reason);
      expect(resolveThreadPanelPullRequestAction(pullRequest) === "merge").toBe(reason === null);
    }
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
