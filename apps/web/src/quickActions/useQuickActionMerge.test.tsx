import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetail,
  type PullRequestRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CommandPaletteOpenDetail } from "../commandPaletteBus";

const { loadDetail, runAction, openPalette } = vi.hoisted(() => ({
  loadDetail: vi.fn(),
  runAction: vi.fn(),
  openPalette: vi.fn(),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => loadDetail }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => runAction }));
vi.mock("../state/pullRequests", () => ({ pullRequestEnvironment: { detail: {}, runAction: {} } }));
vi.mock("../commandPaletteBus", () => ({ openCommandPalette: openPalette }));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}));
import { useQuickActionMerge } from "./useQuickActionMerge";

const environmentId = EnvironmentId.make("remote");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project"),
  repository: "acme/web",
  number: 7,
};
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
let renderer: ReactTestRenderer;
function Probe(_props: { view: ReturnType<typeof useQuickActionMerge> }) {
  return null;
}
function Surface() {
  return <Probe view={useQuickActionMerge()} />;
}
function currentMerge(): ReturnType<typeof useQuickActionMerge> {
  return renderer.root.findByType(Probe).props.view;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  loadDetail.mockReset().mockResolvedValue(AsyncResult.success(detail()));
  runAction.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  act(() => {
    renderer = create(<Surface />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("merge quick action confirmation", () => {
  it("choosing a method confirms and merges without another screen", async () => {
    await currentMerge()(environmentId, [reference]);
    expect(runAction).not.toHaveBeenCalled();
    const view = (openPalette.mock.calls[0]![0] as CommandPaletteOpenDetail).view!;
    const squash = view.groups[0]!.items.find(
      (item) => item.value === "quick-action-merge:squash",
    )!;
    expect(view.groups[0]!.label).toContain("acme/web #7");
    if (squash.kind !== "action") throw new Error("Choosing a method must confirm the merge");
    await squash.run();
    await squash.run();
    expect(openPalette).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledTimes(1);
    const request = runAction.mock.calls[0]![0];
    expect(request.environmentId).toBe(environmentId);
    expect(request.input).toMatchObject({ ...reference, action: "merge" });
    expect(request.input.resolveMergeMethod(detail())).toBe("squash");
    expect(() => request.input.resolveMergeMethod(detail({ mergeability: "conflicting" }))).toThrow(
      "changed",
    );
  });

  it("checks every selected PR and offers only their common methods", async () => {
    loadDetail
      .mockResolvedValueOnce(AsyncResult.success(detail()))
      .mockResolvedValueOnce(
        AsyncResult.success(
          detail({ mergeCapabilities: { merge: false, squash: true, rebase: false } }),
        ),
      );
    const other = { ...reference, repository: "acme/api", number: 9 };
    await currentMerge()(environmentId, [reference, other]);
    const view = (openPalette.mock.calls[0]![0] as CommandPaletteOpenDetail).view!;
    expect(view.groups[0]!.items.map((item) => item.value)).toEqual(["quick-action-merge:squash"]);
    const item = view.groups[0]!.items[0]!;
    if (item.kind !== "action") throw new Error("Expected a merge action");
    await item.run();
    expect(runAction.mock.calls.map(([request]) => request.input.repository)).toEqual([
      "acme/web",
      "acme/api",
    ]);
  });

  it("does not offer a confirmation when fresh status blocks merging", async () => {
    loadDetail.mockResolvedValue(AsyncResult.success(detail({ isDraft: true })));
    await expect(currentMerge()(environmentId, [reference])).rejects.toThrow("not ready to merge");
    expect(openPalette).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });
});
