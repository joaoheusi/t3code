import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuickActionScope } from "./quickActionRunner";
import type { CommandPaletteOpenDetail } from "../commandPaletteBus";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  busy: vi.fn(),
  load: vi.fn(),
  stacked: vi.fn(),
  pull: vi.fn(),
  update: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { status: mocks.status, pull: "pull" },
  vcsActionManager: {
    stateAtom: mocks.busy,
    runStackedAction: (target: unknown) => target,
    track: (_registry: unknown, _target: unknown, _options: unknown, run: () => Promise<unknown>) =>
      run(),
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => mocks.stacked(...args),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.load }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "pull" ? mocks.pull : mocks.update),
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "update" } }));
vi.mock("../commandPaletteBus", () => ({ openCommandPalette: mocks.open }));
vi.mock("../components/GitActionsControl", () => ({ PublishRepositoryDialog: () => null }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn(), update: vi.fn() } }));
import { useQuickActionGit } from "./useQuickActionGit";

const environmentId = EnvironmentId.make("remote");
const scope = {
  environmentId,
  projectId: ProjectId.make("project"),
  thread: {
    id: ThreadId.make("thread"),
    branch: "feature/test",
    workspace: {
      primaryBindingId: "web",
      bindings: [
        { id: "web", label: "web", checkoutPath: "/worktrees/web", state: "ready", error: null },
        { id: "api", label: "api", checkoutPath: "/worktrees/api", state: "ready", error: null },
      ],
    },
  },
} as unknown as QuickActionScope;
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
let registry: ReturnType<typeof AtomRegistry.make>;
let renderer: ReactTestRenderer;

let statuses: Map<
  string,
  Atom.Writable<AsyncResult.Success<VcsStatusResult>, AsyncResult.Success<VcsStatusResult>>
>;
function Probe(_props: { view: ReturnType<typeof useQuickActionGit> }) {
  return null;
}
function Surface() {
  return <Probe view={useQuickActionGit(scope, "/parent", mocks.close)} />;
}
function view(): ReturnType<typeof useQuickActionGit> {
  return renderer.root.findByType(Probe).props.view;
}
const item = (name: string) =>
  view().items.find((entry) => entry.value === `quick-action:git:/worktrees/${name}`)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  registry = AtomRegistry.make();
  statuses = new Map([
    ["/worktrees/web", Atom.make(AsyncResult.success(status({ hasWorkingTreeChanges: true })))],
    ["/worktrees/api", Atom.make(AsyncResult.success(status({ behindCount: 2 })))],
  ]);
  const idle = Atom.make({ isRunning: false });
  mocks.status.mockImplementation(({ input }) => statuses.get(input.cwd)!);
  mocks.busy.mockReturnValue(idle);
  mocks.load.mockImplementation(async ({ input }) => registry.get(statuses.get(input.cwd)!));
  mocks.stacked.mockResolvedValue(
    AsyncResult.success({ branch: { status: "unchanged" }, toast: { title: "Done" } }),
  );
  mocks.pull.mockResolvedValue(AsyncResult.success({ status: "pulled" }));
  act(() => {
    renderer = create(
      <RegistryContext value={registry}>
        <Surface />
      </RegistryContext>,
    );
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("Git palette actions", () => {
  it("runs each repository's displayed action against its own remote environment checkout", async () => {
    expect(item("web").title).toBe("Commit, push & PR · web");
    expect(item("api").title).toBe("Pull · api");
    await act(async () => {
      await item("web").run();
      await item("api").run();
    });
    expect(mocks.stacked.mock.calls[0]![1]).toEqual({ environmentId, cwd: "/worktrees/web" });
    expect(mocks.stacked.mock.calls[0]![2]).toMatchObject({
      action: "commit_push_pr",
      threadId: scope.thread!.id,
    });
    expect(mocks.pull).toHaveBeenCalledWith({ environmentId, input: { cwd: "/worktrees/api" } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("updates the action when repository status changes while the palette is open", async () => {
    await act(async () =>
      registry.set(
        statuses.get("/worktrees/api")!,
        AsyncResult.success(status({ hasWorkingTreeChanges: true })),
      ),
    );
    expect(item("api").title).toBe("Commit, push & PR · api");
  });

  it("does not silently change a selected operation after refreshing", async () => {
    mocks.load.mockResolvedValue(AsyncResult.success(status({ hasWorkingTreeChanges: true })));
    await expect(item("api").run()).rejects.toThrow("status changed");
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("keeps default-branch confirmation and rejects a branch change before confirmation", async () => {
    await act(async () =>
      registry.set(
        statuses.get("/worktrees/web")!,
        AsyncResult.success(
          status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }),
        ),
      ),
    );
    await item("web").run();
    expect(mocks.stacked).not.toHaveBeenCalled();
    const view = (mocks.open.mock.calls[0]![0] as CommandPaletteOpenDetail).view!;
    const confirm = view.groups[0]!.items.find((entry) => entry.value.endsWith(":confirm"))!;
    if (confirm.kind !== "action") throw new Error("Expected a confirmation action");
    mocks.load.mockResolvedValue(
      AsyncResult.success(status({ refName: "another", hasWorkingTreeChanges: true })),
    );
    await expect(confirm.run()).rejects.toThrow("status changed");
    expect(mocks.stacked).not.toHaveBeenCalled();
  });
});
