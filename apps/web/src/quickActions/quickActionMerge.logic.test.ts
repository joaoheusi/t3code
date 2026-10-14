import type { PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { quickActionMergeMethod } from "./quickActionMerge.logic";

const detail = (overrides: Partial<PullRequestDetail> = {}) =>
  ({
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    checks: [],
    capabilities: { actions: ["merge"], mergeMethods: ["merge", "squash", "rebase"] },
    viewerPermissions: { actions: ["merge"] },
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    ...overrides,
  }) as PullRequestDetail;

describe("merge quick action eligibility", () => {
  it("picks each PR's own method, so a batch needs no shared method", () => {
    expect(quickActionMergeMethod(detail())).toBe("merge");
    expect(
      quickActionMergeMethod(
        detail({ mergeCapabilities: { merge: false, squash: true, rebase: false } }),
      ),
    ).toBe("squash");
    expect(
      quickActionMergeMethod(
        detail({ mergeCapabilities: { merge: false, squash: false, rebase: true } }),
      ),
    ).toBe("rebase");
  });

  it.each([
    { state: "merged" },
    { state: "closed" },
    { isDraft: true },
    { mergeability: "conflicting" },
    { checks: [{ status: "failure" }] },
    { checks: [{ status: "pending" }] },
    { viewerPermissions: { actions: [] } },
  ])("refuses a PR that cannot merge right now: %j", (overrides) => {
    expect(quickActionMergeMethod(detail(overrides as Partial<PullRequestDetail>))).toBeNull();
  });
});
