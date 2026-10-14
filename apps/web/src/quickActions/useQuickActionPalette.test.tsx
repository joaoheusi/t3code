import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuickActionScope } from "./quickActionRunner";

const mocks = vi.hoisted(() => ({
  merge: vi.fn(async () => {}),
  run: vi.fn(async () => {}),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));
vi.mock("../state/pullRequests", () => ({
  pullRequestEnvironment: { detail: () => ({}) },
}));
vi.mock("./useQuickActions", () => ({
  useQuickActionLibrary: () => ({ actions: [], supported: true, isPending: false, error: null }),
  useRunQuickAction: () => ({ run: mocks.run }),
}));
vi.mock("./useQuickActionGit", () => ({
  useQuickActionGit: () => ({ items: [], dialog: null }),
}));
vi.mock("./useQuickActionMerge", () => ({
  useQuickActionMerge: () => mocks.merge,
}));
vi.mock("./QuickActionPullRequestStatus", () => ({
  QuickActionPullRequestStatus: () => null,
}));
import { useQuickActionPalette } from "./useQuickActionPalette";

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const link = (repository: string, number: number, bindingId: string) => ({
  host: "github.com",
  repository,
  number,
  bindingId,
  snapshot: null,
  source: "branch",
  linkedAt: "2026-10-13T00:00:00.000Z",
  url: `https://github.com/${repository}/pull/${number}`,
});
const scope = {
  environmentId,
  projectId,
  thread: {
    id: ThreadId.make("thread"),
    pullRequests: [link("acme/web", 7, "web"), link("acme/api", 9, "api")],
    workspace: {
      primaryBindingId: "web",
      bindings: [
        { id: "web", label: "web" },
        { id: "api", label: "api" },
      ],
    },
  },
} as unknown as QuickActionScope;

let renderer: ReactTestRenderer;
function Probe(_props: { view: ReturnType<typeof useQuickActionPalette> }) {
  return null;
}
function Surface() {
  return (
    <Probe
      view={useQuickActionPalette({
        target: { threadId: ThreadId.make("thread") } as never,
        scope,
        gitCwd: null,
        onClose: () => {},
        onManage: async () => {},
        onCreate: async () => {},
      })}
    />
  );
}
function view(): ReturnType<typeof useQuickActionPalette> {
  return renderer.root.findByType(Probe).props.view;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.merge.mockReset().mockResolvedValue(undefined);
  act(() => {
    renderer = create(<Surface />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("merge quick action palette item", () => {
  it("is a toggle view whose rows never submit a single PR on their own", async () => {
    const item = view().groups[0]!.items.find((entry) => entry.value === "quick-action:merge")!;
    expect(item.kind).toBe("submenu");
    if (item.kind !== "submenu") throw new Error("Expected the merge toggle view");
    expect(item.multiSelect?.actionLabel).toBe("Continue");

    const rows = item.groups[0]!.items;
    expect(rows.map((row) => row.value)).toEqual([
      "quick-action:merge:github.com/acme/web#7|web",
      "quick-action:merge:github.com/acme/api#9|api",
    ]);
    for (const row of rows) {
      if (row.kind !== "action") throw new Error("Expected toggle rows");
      await row.run();
    }
    expect(mocks.merge).not.toHaveBeenCalled();

    await item.multiSelect!.run(rows.map((row) => row.value));
    expect(mocks.merge).toHaveBeenCalledTimes(1);
    expect(mocks.merge).toHaveBeenCalledWith(environmentId, [
      { host: "github.com", repository: "acme/web", number: 7, projectId },
      { host: "github.com", repository: "acme/api", number: 9, projectId },
    ]);
  });
});
