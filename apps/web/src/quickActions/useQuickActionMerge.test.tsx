import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetail,
  type PullRequestRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { loadDetail, runAction, toast } = vi.hoisted(() => ({
  loadDetail: vi.fn(),
  runAction: vi.fn(),
  toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => loadDetail }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => runAction }));
vi.mock("../state/pullRequests", () => ({ pullRequestEnvironment: { detail: {}, runAction: {} } }));
vi.mock("../components/ui/toast", () => ({
  toastManager: toast,
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
  toast.add.mockImplementation(({ title }) => title);
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

describe("merge quick action", () => {
  it("propagates a failed refresh to the palette's error handler and allows retry", async () => {
    loadDetail.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Connection lost"))));
    await expect(currentMerge()(environmentId, [reference])).rejects.toThrow("Connection lost");
    expect(toast.close).toHaveBeenCalledWith("Checking pull requests before merging…");
    expect(runAction).not.toHaveBeenCalled();

    await currentMerge()(environmentId, [reference]);
    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("merges in the same pass, with progress and failure feedback", async () => {
    let finishCheck!: (detailValue: AsyncResult.Success<PullRequestDetail>) => void;
    const checked = new Promise<AsyncResult.Success<PullRequestDetail>>((resolve) => {
      finishCheck = resolve;
    });
    loadDetail.mockReturnValueOnce(checked);
    let failMerge!: (error: Error) => void;
    runAction.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        failMerge = reject;
      }),
    );
    const merging = currentMerge()(environmentId, [reference]);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Checking pull requests before merging…",
      }),
    );
    await currentMerge()(environmentId, [reference]);
    expect(loadDetail).toHaveBeenCalledTimes(1);
    finishCheck(AsyncResult.success(detail()));
    // Let the check finish so the merge starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(toast.close).toHaveBeenCalledWith("Checking pull requests before merging…");
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Merging 1 pull request…",
      }),
    );
    expect(toast.update).toHaveBeenLastCalledWith("Merging 1 pull request…", {
      description: "acme/web #7",
    });
    failMerge(new Error("Connection lost"));
    await merging;
    expect(toast.update).toHaveBeenLastCalledWith(
      "Merging 1 pull request…",
      expect.objectContaining({
        type: "error",
        title: "Merged 0 of 1 pull requests",
        description: "acme/web #7: Connection lost",
      }),
    );
  });

  it("merges with the PR's default method and rechecks it in the write lane", async () => {
    await currentMerge()(environmentId, [reference]);
    expect(runAction).toHaveBeenCalledTimes(1);
    const request = runAction.mock.calls[0]![0];
    expect(request.environmentId).toBe(environmentId);
    expect(request.input).toMatchObject({ ...reference, action: "merge" });
    expect(request.input.resolveMergeMethod(detail())).toBe("merge");
    expect(() => request.input.resolveMergeMethod(detail({ mergeability: "conflicting" }))).toThrow(
      "changed",
    );
    expect(toast.update).toHaveBeenLastCalledWith(
      "Merging 1 pull request…",
      expect.objectContaining({
        type: "success",
        title: "Merged 1 of 1 pull requests",
        description: "acme/web #7 · Merge",
      }),
    );
  });

  it("merges every selected PR in one pass, each with its own method", async () => {
    loadDetail
      .mockResolvedValueOnce(
        AsyncResult.success(
          detail({ mergeCapabilities: { merge: true, squash: false, rebase: false } }),
        ),
      )
      .mockResolvedValueOnce(
        AsyncResult.success(
          detail({ mergeCapabilities: { merge: false, squash: true, rebase: false } }),
        ),
      );
    const other = { ...reference, repository: "acme/api", number: 9 };
    await currentMerge()(environmentId, [reference, other]);
    expect(runAction.mock.calls.map(([request]) => request.input.repository)).toEqual([
      "acme/web",
      "acme/api",
    ]);
    expect(
      runAction.mock.calls.map(([request]) =>
        request.input.resolveMergeMethod(
          detail(
            request.input.repository === "acme/web"
              ? { mergeCapabilities: { merge: true, squash: false, rebase: false } }
              : { mergeCapabilities: { merge: false, squash: true, rebase: false } },
          ),
        ),
      ),
    ).toEqual(["merge", "squash"]);
    expect(toast.update).toHaveBeenLastCalledWith(
      "Merging 2 pull requests…",
      expect.objectContaining({
        type: "success",
        title: "Merged 2 of 2 pull requests",
        description: "acme/web #7 · Merge\nacme/api #9 · Squash and merge",
      }),
    );
  });

  it("does not merge when fresh status blocks merging", async () => {
    loadDetail.mockResolvedValue(AsyncResult.success(detail({ isDraft: true })));
    await expect(currentMerge()(environmentId, [reference])).rejects.toThrow(
      "acme/web #7: Still a draft.",
    );
    expect(runAction).not.toHaveBeenCalled();
  });
});
