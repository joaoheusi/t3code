// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  AuthSourceControlWriteScope,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  load: vi.fn(),
  busy: vi.fn(),
  stacked: vi.fn(),
  pull: vi.fn(),
  permission: vi.fn(),
  alert: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ActivityIndicator: () => null,
  Alert: { alert: mocks.alert },
}));
vi.mock("../../components/PickerList", () => ({
  PickerCaption: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  PickerRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
  PickerSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ForkScreenHeader", () => ({
  ForkScreenHeader: ({
    action,
  }: {
    action?: { accessibilityLabel: string; disabled?: boolean; onPress: () => void };
  }) =>
    action ? (
      <button disabled={action.disabled} onClick={action.onPress}>
        {action.accessibilityLabel}
      </button>
    ) : null,
}));
vi.mock("../../state/entities", () => ({
  useProject: () => ({ workspaceRoot: "/repo" }),
  useThreadShell: () => ({
    id: "thread",
    branch: "feature/test",
    workspace: {
      primaryBindingId: "app",
      bindings: [
        { id: "app", checkoutPath: "/repo/app", label: "App", state: "ready", error: null },
        { id: "api", checkoutPath: "/repo/api", label: "API", state: "ready", error: null },
      ],
    },
  }),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (...args: unknown[]) => mocks.permission(...args),
  useEnvironmentScope: (...args: unknown[]) => mocks.permission(...args),
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: mocks.status, refreshStatus: "refresh", pull: "pull" },
  vcsActionManager: {
    stateAtom: mocks.busy,
    runStackedAction: (target: unknown) => target,
    track: (_registry: unknown, _target: unknown, _options: unknown, run: () => Promise<unknown>) =>
      run(),
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => mocks.stacked(...args),
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.load }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "refresh" ? mocks.load : command === "pull" ? mocks.pull : vi.fn(),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { updateMetadata: "update" } }));
vi.mock("../../state/use-vcs-action-state", () => ({ showGitActionResult: vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "action-id" }));
import { MobileGitQuickAction } from "./MobileGitQuickAction";

const environmentId = EnvironmentId.make("remote");
const target = {
  environmentId,
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  draftKey: "draft",
};
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
let renderer: Root;
let container: HTMLDivElement;
let statuses: Map<
  string,
  Atom.Writable<AsyncResult.Success<VcsStatusResult>, AsyncResult.Success<VcsStatusResult>>
>;
const row = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent!.startsWith(name),
  )!;
const submit = () => row("Sync selected");
/** Toggles the named rows, then submits the selection like the header action. */
const chooseAndSync = async (...names: string[]) => {
  for (const name of names) {
    await act(async () => {
      row(name).click();
    });
  }
  await act(async () => {
    submit().click();
  });
};
const render = (choosing = true) => (
  <RegistryContext value={registry}>
    <MobileGitQuickAction
      target={target}
      query=""
      choosing={choosing}
      onChoosingChange={vi.fn()}
      onClose={mocks.close}
    />
  </RegistryContext>
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.permission.mockReturnValue(true);
  registry = AtomRegistry.make();
  statuses = new Map([
    ["/repo/app", Atom.make(AsyncResult.success(status({ hasWorkingTreeChanges: true })))],
    ["/repo/api", Atom.make(AsyncResult.success(status({ behindCount: 2 })))],
  ]);
  mocks.status.mockImplementation(({ input }) => statuses.get(input.cwd)!);
  mocks.busy.mockReturnValue(Atom.make({ isRunning: false }));
  mocks.load.mockImplementation(async ({ input }) => registry.get(statuses.get(input.cwd)!));
  mocks.stacked.mockResolvedValue(
    AsyncResult.success({ branch: { status: "unchanged" }, toast: { title: "Done" } }),
  );
  mocks.pull.mockResolvedValue(AsyncResult.success({ status: "pulled" }));
  act(() => {
    container = document.createElement("div");
    renderer = createRoot(container);
    renderer.render(render());
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("native Git quick action", () => {
  it("keeps rows disabled while a submitted selection checks and runs", async () => {
    const refresh = Promise.withResolvers<AsyncResult.Success<VcsStatusResult>>();
    const complete = Promise.withResolvers<AsyncResult.Success<unknown>>();
    mocks.load.mockReturnValueOnce(refresh.promise);
    mocks.stacked.mockReturnValueOnce(complete.promise);
    await act(async () => {
      row("App").click();
    });
    expect(submit().disabled).toBe(false);
    await act(async () => {
      submit().click();
    });
    expect(row("App").disabled).toBe(true);
    expect(mocks.stacked).not.toHaveBeenCalled();
    await act(async () => {
      refresh.resolve(AsyncResult.success(status({ hasWorkingTreeChanges: true })));
    });
    expect(mocks.stacked).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    await act(async () => {
      complete.resolve(
        AsyncResult.success({ branch: { status: "unchanged" }, toast: { title: "Committed" } }),
      );
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("toggles rows without running them until the selection is submitted", async () => {
    await act(async () => {
      row("API").click();
      row("API").click();
    });
    expect(submit().disabled).toBe(true);
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.stacked).not.toHaveBeenCalled();
  });

  it("runs only the selected repository's operation in its destination environment", async () => {
    await chooseAndSync("API");
    expect(mocks.pull).toHaveBeenCalledWith({ environmentId, input: { cwd: "/repo/api" } });
    expect(mocks.stacked).not.toHaveBeenCalled();
  });

  it("runs each selected repository's own action in one batch", async () => {
    await chooseAndSync("App", "API");
    expect(mocks.stacked.mock.calls[0]![1]).toEqual({ environmentId, cwd: "/repo/app" });
    expect(mocks.stacked.mock.calls[0]![2]).toMatchObject({
      action: "commit_push_pr",
      threadId: "thread",
    });
    expect(mocks.pull).toHaveBeenCalledWith({ environmentId, input: { cwd: "/repo/api" } });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("drops synced repositories from the selection so a partly failed batch can retry", async () => {
    mocks.pull.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Network down"))));
    await chooseAndSync("App", "API");
    expect(mocks.stacked).toHaveBeenCalledTimes(1);
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    // The synced repository now reports no work, so its row is disabled.
    await act(async () => registry.set(statuses.get("/repo/app")!, AsyncResult.success(status())));
    expect(submit().disabled).toBe(false);
    await act(async () => {
      submit().click();
    });
    expect(mocks.pull).toHaveBeenCalledTimes(2);
    expect(mocks.stacked).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("refuses a write when the displayed branch changes during refresh", async () => {
    mocks.load.mockResolvedValue(AsyncResult.success(status({ refName: "other", behindCount: 2 })));
    await chooseAndSync("API");
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("rechecks destination permission after refresh", async () => {
    mocks.load.mockImplementation(async ({ input }) => {
      mocks.permission.mockImplementation(
        (_env, permission) => permission !== AuthSourceControlWriteScope,
      );
      return registry.get(statuses.get(input.cwd)!);
    });
    await chooseAndSync("App");
    expect(mocks.stacked).not.toHaveBeenCalled();
  });
  it("confirms default-branch repositories once for the batch and rejects a later branch change", async () => {
    await act(async () =>
      registry.set(
        statuses.get("/repo/app")!,
        AsyncResult.success(
          status({ refName: "main", isDefaultRef: true, hasWorkingTreeChanges: true }),
        ),
      ),
    );
    await chooseAndSync("App", "API");
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const buttons = mocks.alert.mock.calls[0]![2];
    mocks.load.mockResolvedValue(
      AsyncResult.success(status({ refName: "another", hasWorkingTreeChanges: true })),
    );
    await act(async () => {
      buttons[2].onPress();
    });
    expect(mocks.stacked).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });
});
