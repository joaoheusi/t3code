import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
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
  permission: vi.fn(),
  toast: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: (...args: unknown[]) => mocks.permission(...args),
  readEnvironmentScope: (...args: unknown[]) => mocks.permission(...args),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { status: mocks.status, refreshStatus: "refresh", pull: "pull" },
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
  useAtomCommand: (command: string) =>
    command === "refresh" ? mocks.load : command === "pull" ? mocks.pull : mocks.update,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "update" } }));
vi.mock("../commandPaletteBus", () => ({ openCommandPalette: mocks.open }));
vi.mock("../components/GitActionsControl", () => ({ PublishRepositoryDialog: () => null }));
vi.mock("../components/ui/toast", () => ({ toastManager: mocks.toast }));
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
function setup() {
  vi.clearAllMocks();
  mocks.permission.mockReturnValue(true);
  mocks.toast.add.mockImplementation(({ title }) => title);
  const registry = AtomRegistry.make();
  const statuses = new Map([
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

  let latestProbeView: ReturnType<typeof useQuickActionGit>;
  function Probe(props: { view: ReturnType<typeof useQuickActionGit> }) {
    latestProbeView = props.view;
    return null;
  }
  function Surface() {
    return <Probe view={useQuickActionGit(scope, "/parent", mocks.close)} />;
  }
  function view(): ReturnType<typeof useQuickActionGit> {
    return latestProbeView;
  }
  const item = (name: string) =>
    view().repositoryItems.find((entry) => entry.value === `quick-action:git:/worktrees/${name}`)!;

  const submitBatch = async (values: readonly string[]) => {
    const entry = view().items[0]!;
    if (entry.kind !== "submenu" || !entry.multiSelect)
      throw new Error("Expected the repository toggle picker");
    await act(async () => {
      await entry.multiSelect!.run(values);
    });
  };
  function MountedSurface({ children }: { children: import("react").ReactNode }) {
    return <RegistryContext value={registry}>{children}</RegistryContext>;
  }
  return {
    Surface,
    MountedSurface,
    view,
    item,
    registry,
    statuses,
    submitBatch,
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("Git palette actions", () => {
  it("acknowledges a click before a slow status check and ignores a second click", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    let finishRefresh!: (status: AsyncResult.Success<VcsStatusResult>) => void;
    const refresh = new Promise<AsyncResult.Success<VcsStatusResult>>((resolve) => {
      finishRefresh = resolve;
    });
    mocks.load.mockReturnValueOnce(refresh);
    const action = item("web");
    const running = action.run();
    expect(mocks.toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Checking repository status…",
      }),
    );
    expect(mocks.stacked).not.toHaveBeenCalled();
    await action.run();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishRefresh(AsyncResult.success(status({ hasWorkingTreeChanges: true })));
      await running;
    });
    expect(mocks.toast.close).toHaveBeenCalledWith("Checking repository status…");
    expect(mocks.stacked).toHaveBeenCalledTimes(1);
  });

  it("still runs the action when the palette closes during a slow status check", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item } = harness;
    await using screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    let finishRefresh!: (status: AsyncResult.Success<VcsStatusResult>) => void;
    mocks.load.mockReturnValueOnce(
      new Promise<AsyncResult.Success<VcsStatusResult>>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const running = item("web").run();
    await screen.unmount();
    finishRefresh(AsyncResult.success(status({ hasWorkingTreeChanges: true })));
    await running;
    expect(mocks.stacked).toHaveBeenCalledTimes(1);
  });

  it("keeps progress visible through generation and hooks, then reports completion", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item, registry } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    const state = Atom.make({ isRunning: false, currentLabel: "Generating commit message..." });
    mocks.busy.mockReturnValue(state);
    mocks.stacked.mockImplementationOnce(async (_registry, _target, input) => {
      const progress = "Commit, push & PR…";
      expect(mocks.toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: progress,
        }),
      );
      input.onProgress({ kind: "phase_started" });
      expect(mocks.toast.update).toHaveBeenLastCalledWith(progress, {
        title: "Generating commit message...",
      });
      registry.set(state, { isRunning: true, currentLabel: "Running pre-commit..." });
      input.onProgress({ kind: "hook_started" });
      expect(mocks.toast.update).toHaveBeenLastCalledWith(progress, {
        title: "Running pre-commit...",
      });
      const updates = mocks.toast.update.mock.calls.length;
      input.onProgress({ kind: "hook_output" });
      expect(mocks.toast.update).toHaveBeenCalledTimes(updates);
      return AsyncResult.success({
        branch: { status: "unchanged" },
        toast: { title: "Committed" },
      });
    });
    await act(async () => {
      await item("web").run();
    });
    expect(mocks.toast.update).toHaveBeenLastCalledWith(
      "Commit, push & PR…",
      expect.objectContaining({
        type: "success",
        title: "Committed",
      }),
    );
  });

  it("cleans up status feedback on failure and allows another attempt", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    mocks.load.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(item("web").run()).rejects.toThrow("Connection lost");
    expect(mocks.toast.close).toHaveBeenCalledWith("Checking repository status…");
    await act(async () => {
      await item("web").run();
    });
    expect(mocks.stacked).toHaveBeenCalledTimes(1);
  });

  it("offers one entry for a mixed repository set as a toggle picker like other quick actions", async () => {
    using harness = setup();
    const { Surface, MountedSurface, view } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    expect(view().items).toHaveLength(1);
    const entry = view().items[0]!;
    expect(entry.title).toBe("Sync repositories");
    expect(entry.kind).toBe("submenu");
    if (entry.kind !== "submenu") throw new Error("Expected the repository toggle picker");
    expect(entry.multiSelect?.actionLabel).toBe("Sync selected");
    expect(entry.groups[0]!.label).toBe("Choose repositories");
    expect(entry.groups[0]!.items.map((row) => row.value)).toEqual([
      "quick-action:git:/worktrees/web",
      "quick-action:git:/worktrees/api",
    ]);
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("runs each selected repository's own action in one batch and skips the rest", async () => {
    using harness = setup();
    const { Surface, MountedSurface, submitBatch } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    await submitBatch(["quick-action:git:/worktrees/api"]);
    expect(mocks.pull).toHaveBeenCalledWith({ environmentId, input: { cwd: "/worktrees/api" } });
    expect(mocks.stacked).not.toHaveBeenCalled();

    await submitBatch(["quick-action:git:/worktrees/web", "quick-action:git:/worktrees/api"]);
    expect(mocks.stacked.mock.calls[0]![1]).toEqual({ environmentId, cwd: "/worktrees/web" });
    expect(mocks.stacked.mock.calls[0]![2]).toMatchObject({ action: "commit_push_pr" });
    expect(mocks.pull).toHaveBeenCalledTimes(2);
    expect(mocks.toast.update).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "success", title: "Synced 2 repositories" }),
    );
  });

  it("checks every selected repository before any batch write", async () => {
    using harness = setup();
    const { Surface, MountedSurface, view, registry, statuses } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    mocks.load.mockImplementation(async ({ input }) =>
      input.cwd === "/worktrees/api"
        ? AsyncResult.success(status({ hasWorkingTreeChanges: true }))
        : registry.get(statuses.get(input.cwd)!),
    );
    const entry = view().items[0]!;
    if (entry.kind !== "submenu" || !entry.multiSelect)
      throw new Error("Expected the repository toggle picker");
    await expect(
      entry.multiSelect.run(["quick-action:git:/worktrees/web", "quick-action:git:/worktrees/api"]),
    ).rejects.toThrow("status changed");
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("confirms default-branch repositories once for the whole batch", async () => {
    using harness = setup();
    const { Surface, MountedSurface, registry, statuses, submitBatch } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    await act(async () =>
      registry.set(
        statuses.get("/worktrees/web")!,
        AsyncResult.success(
          status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }),
        ),
      ),
    );
    await submitBatch(["quick-action:git:/worktrees/web", "quick-action:git:/worktrees/api"]);
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
    const detail = mocks.open.mock.calls[0]![0] as CommandPaletteOpenDetail;
    const confirmation = detail.pushView!;
    const feature = confirmation.groups[0]!.items.find((entry) =>
      entry.value.endsWith("batch:feature"),
    )!;
    expect(feature.description).toContain("plus 1 other repository");
    if (feature.kind !== "action") throw new Error("Expected a confirmation action");
    await act(async () => {
      await feature.run();
    });
    expect(mocks.stacked.mock.calls[0]![2].featureBranch).toBe(true);
    expect(mocks.pull).toHaveBeenCalledWith({ environmentId, input: { cwd: "/worktrees/api" } });
  });
  it("disables writes for a read-only connection", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item } = harness;
    await using screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    mocks.permission.mockImplementation(
      (_environment, permission) => permission !== AuthSourceControlWriteScope,
    );
    await screen.rerender(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    expect(item("web").disabled).toBe(true);
    expect(item("api").disabled).toBe(true);
    await expect(item("api").run()).rejects.toThrow("cannot change source control");
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("rejects a write if permission is revoked during the status refresh", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item, registry, statuses } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    mocks.load.mockImplementation(async ({ input }) => {
      mocks.permission.mockReturnValue(false);
      return registry.get(statuses.get(input.cwd)!);
    });
    await expect(item("web").run()).rejects.toThrow("cannot change source control");
    expect(mocks.stacked).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rechecks thread permission before creating a feature branch (initially allowed: %s)",
    async (initiallyAllowed) => {
      using harness = setup();
      const { Surface, MountedSurface, item, registry, statuses } = harness;
      await using _screen = await render(
        <MountedSurface>
          <Surface />
        </MountedSurface>,
      );
      mocks.permission.mockImplementation(
        (_environment, permission) =>
          initiallyAllowed || permission !== AuthOrchestrationOperateScope,
      );
      await act(async () =>
        registry.set(
          statuses.get("/worktrees/web")!,
          AsyncResult.success(
            status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }),
          ),
        ),
      );
      await item("web").run();
      const confirmation = (mocks.open.mock.calls[0]![0] as CommandPaletteOpenDetail).view!;
      const feature = confirmation.groups[0]!.items.find((entry) =>
        entry.value.endsWith(":feature"),
      )!;
      expect(feature.disabled).toBe(!initiallyAllowed);
      mocks.permission.mockImplementation(
        (_environment, permission) => permission !== AuthOrchestrationOperateScope,
      );
      if (feature.kind !== "action") throw new Error("Expected an action");
      await expect(feature.run()).rejects.toThrow("cannot change the thread's branch");
      expect(mocks.stacked).not.toHaveBeenCalled();
    },
  );

  it("runs each repository's displayed action against its own remote environment checkout", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    expect(item("web").title).toBe("web: Commit, push & PR");
    expect(item("api").title).toBe("api: Pull");
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
    using harness = setup();
    const { Surface, MountedSurface, item, registry, statuses } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    await act(async () =>
      registry.set(
        statuses.get("/worktrees/api")!,
        AsyncResult.success(status({ hasWorkingTreeChanges: true })),
      ),
    );
    expect(item("api").title).toBe("api: Commit, push & PR");
  });

  it("does not silently change a selected operation after refreshing", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
    mocks.load.mockResolvedValue(AsyncResult.success(status({ hasWorkingTreeChanges: true })));
    await expect(item("api").run()).rejects.toThrow("status changed");
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it("keeps default-branch confirmation and rejects a branch change before confirmation", async () => {
    using harness = setup();
    const { Surface, MountedSurface, item, registry, statuses } = harness;
    await using _screen = await render(
      <MountedSurface>
        <Surface />
      </MountedSurface>,
    );
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

  it.each(["feature", "confirm"])(
    "allows retrying %s after a failed recheck without allowing duplicate writes",
    async (choice) => {
      using harness = setup();
      const { Surface, MountedSurface, item, registry, statuses } = harness;
      await using _screen = await render(
        <MountedSurface>
          <Surface />
        </MountedSurface>,
      );
      await act(async () =>
        registry.set(
          statuses.get("/worktrees/web")!,
          AsyncResult.success(
            status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }),
          ),
        ),
      );
      await item("web").run();
      const confirmation = (mocks.open.mock.calls[0]![0] as CommandPaletteOpenDetail).view!;
      const confirm = confirmation.groups[0]!.items.find((entry) =>
        entry.value.endsWith(`:${choice}`),
      )!;
      if (confirm.kind !== "action") throw new Error("Expected a confirmation action");
      expect(confirm.keepOpen).toBe(true);
      let failRefresh!: (error: Error) => void;
      mocks.load.mockReturnValueOnce(
        new Promise<never>((_resolve, reject) => {
          failRefresh = reject;
        }),
      );
      const attempt = confirm.run();
      await confirm.run();
      expect(mocks.load).toHaveBeenCalledTimes(2);
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.stacked).not.toHaveBeenCalled();

      const rejected = expect(attempt).rejects.toThrow("Connection lost");
      failRefresh(new Error("Connection lost"));
      await rejected;
      expect(mocks.close).not.toHaveBeenCalled();

      await act(async () => {
        await confirm.run();
        await confirm.run();
      });
      expect(mocks.load).toHaveBeenCalledTimes(3);
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(mocks.stacked).toHaveBeenCalledTimes(1);
      expect(mocks.stacked.mock.calls[0]![2].featureBranch).toBe(choice === "feature");
    },
  );
});
