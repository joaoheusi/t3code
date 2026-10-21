import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";

vi.mock(import("./BranchToolbarBranchSelector"), async (original) => ({
  ...(await original()),
  BranchToolbarBranchSelector: (() => null) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: (() => ({ workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));

import { BranchToolbar } from "./BranchToolbar";

function renderToolbar(props: Partial<ComponentProps<typeof BranchToolbar>>) {
  return render(
    <BranchToolbar
      layout="panel"
      panelSection="workspace"
      environmentId={EnvironmentId.make("local")}
      threadId={ThreadId.make("thread")}
      projectId={ProjectId.make("project")}
      worktreePath={null}
      isServerThread
      showGitControls
      envMode="local"
      envLocked={false}
      startFromOrigin={false}
      onStartFromOriginChange={vi.fn()}
      onEnvModeChange={vi.fn()}
      {...props}
    />,
    { router: false },
  );
}

it("advances from machine to workspace in one menu session", async () => {
  const onEnvironmentChange = vi.fn();
  const onEnvModeChange = vi.fn();
  await using screen = await renderToolbar({
    onEnvironmentChange,
    onEnvModeChange,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server" as const,
    })),
  });
  const trigger = screen.container.querySelector("button")!;
  const radioLabels = () =>
    Array.from(document.querySelectorAll('[role="menuitemradio"]')).map(
      (element) => element.textContent,
    );

  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitemradio", { name: "remote" })).toBeVisible();
  expect(radioLabels()).not.toContain("New worktree");

  await userEvent.click(page.getByRole("menuitemradio", { name: "remote" }));
  expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
  await expect.element(page.getByRole("menuitemradio", { name: "New worktree" })).toBeVisible();
  expect(radioLabels()).not.toContain("remote");
  expect(document.activeElement?.textContent).toContain("Current checkout");

  await userEvent.click(page.getByRole("menuitemradio", { name: "New worktree" }));
  expect(onEnvModeChange).toHaveBeenCalledWith("worktree");
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

  onEnvironmentChange.mockClear();
  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitemradio", { name: "remote" })).toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "New worktree" })).toBeVisible();
  expect(onEnvironmentChange).not.toHaveBeenCalled();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio", { name: "remote" })).toBeVisible();

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio", { name: "New worktree" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
});
