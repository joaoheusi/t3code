import type { PullRequestDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { quickActionMergeMethods } from "./quickActionMerge.logic";

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
  it("offers only methods every selected repository allows", () => {
    expect(
      quickActionMergeMethods([
        detail(),
        detail({ mergeCapabilities: { merge: false, squash: true, rebase: false } }),
      ]),
    ).toEqual(["squash"]);
    expect(quickActionMergeMethods([])).toEqual([]);
    expect(
      quickActionMergeMethods([
        detail({ mergeCapabilities: { merge: true, squash: false, rebase: false } }),
        detail({ mergeCapabilities: { merge: false, squash: true, rebase: false } }),
      ]),
    ).toEqual([]);
  });

  it.each([
    { state: "merged" },
    { state: "closed" },
    { isDraft: true },
    { mergeability: "conflicting" },
    { checks: [{ status: "failure" }] },
    { checks: [{ status: "pending" }] },
    { viewerPermissions: { actions: [] } },
  ])("refuses the batch when a selected PR is ineligible: %j", (overrides) => {
    expect(
      quickActionMergeMethods([detail(), detail(overrides as Partial<PullRequestDetail>)]),
    ).toEqual([]);
  });
});
