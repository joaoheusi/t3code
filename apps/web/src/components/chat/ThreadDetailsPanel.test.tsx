import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  repositoryBindings: [] as ReadonlyArray<unknown>,
  branchRows: [] as Array<unknown>,
  pullRequestRows: [] as Array<unknown>,
  gitActions: [] as Array<unknown>,
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));
vi.mock("../../workspace/ThreadRepositoriesSection", () => ({
  ThreadRepositoriesSection: () => null,
  useActiveRepository: () => testState.repositoryBindings[0] ?? null,
  useRepositoryBindings: () => testState.repositoryBindings,
  RepositoryBranchRow: (props: unknown) => {
    testState.branchRows.push(props);
    return null;
  },
  RepositoryPullRequestRows: (props: unknown) => {
    testState.pullRequestRows.push(props);
    return null;
  },
}));
vi.mock("../GitActionsControl", () => ({
  default: (props: unknown) => {
    testState.gitActions.push(props);
    return null;
  },
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset().mockReturnValue([]);
    testState.projectScriptsControl.mockReset();
    testState.repositoryBindings = [];
    testState.branchRows = [];
    testState.pullRequestRows = [];
    testState.gitActions = [];
  });

  const baseProps = (
    overrides: Partial<ThreadDetailsPanelProps> = {},
  ): ThreadDetailsPanelProps => ({
    anchor: { current: null },
    handle: PopoverCreateHandle(),
    onPresentationChange: vi.fn(),
    environmentId: "environment:thread-details" as EnvironmentId,
    threadId: "thread:thread-details" as ThreadId,
    activeProjectName: undefined,
    activeProjectScripts: [],
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    gitCwd: "/tmp/thread-details-project",
    isGitRepo: false,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    envMode: "local",
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
    onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
    onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    ...overrides,
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("shows a full version control block for every repository", () => {
    const web = { id: "web", state: "ready", checkoutPath: "/tmp/web", label: "web" };
    const api = { id: "api", state: "ready", checkoutPath: "/tmp/api", label: "api" };
    const pending = { id: "docs", state: "preparing", checkoutPath: "/tmp/docs", label: "docs" };
    testState.repositoryBindings = [web, api, pending];

    renderToStaticMarkup(<ThreadDetailsPanel {...baseProps({ activeProjectName: "Project" })} />);

    expect(testState.branchRows).toEqual([
      expect.objectContaining({ binding: web }),
      expect.objectContaining({ binding: api }),
      expect.objectContaining({ binding: pending }),
    ]);
    expect(testState.pullRequestRows).toEqual([
      expect.objectContaining({ binding: web }),
      expect.objectContaining({ binding: api }),
      expect.objectContaining({ binding: pending }),
    ]);
    // A repository that is not ready yet has no checkout to run Git actions in.
    expect(testState.gitActions).toEqual([
      expect.objectContaining({ gitCwd: "/tmp/web" }),
      expect.objectContaining({ gitCwd: "/tmp/api" }),
    ]);
  });
});
