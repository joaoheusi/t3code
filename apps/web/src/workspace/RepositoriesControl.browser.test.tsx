import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

vi.mock(import("./useAddRepository"), () => ({
  useAddRepository: (() => ({
    projects: [],
    addPath: vi.fn(async () => undefined),
    browse: vi.fn(),
  })) as never,
}));

import { RepositoriesControl } from "./RepositoriesControl";
import type { DraftRepository } from "./workspaceModel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const repository = (label: string): DraftRepository => ({
  id: label,
  label,
  path: `/tmp/movitera/${label}`,
  commonDir: `/tmp/movitera/${label}/.git`,
  mode: "new-worktree",
  branch: "main",
  head: "abc123",
});

function render(loading: boolean) {
  const repositories = [repository("movitera-web"), repository("movitera-backend")];
  return act(async () =>
    root.render(
      <RepositoriesControl
        environmentId={EnvironmentId.make("local")}
        threadId={ThreadId.make("thread")}
        composerKey="draft-1"
        project={{
          id: ProjectId.make("project"),
          title: "movitera",
          workspaceRoot: "/tmp/movitera",
        }}
        isGitRepo={false}
        repositories={
          {
            workspace: undefined,
            started: false,
            editable: true,
            selection: {
              repositories,
              loading,
              folder: true,
              foundCount: repositories.length,
              untouched: true,
              saved: [],
            },
            visible: true,
            loading,
            folder: true,
            labels: repositories.map((entry) => entry.label),
            multiple: !loading,
          } as never
        }
        envMode="worktree"
        envModeLocked={false}
        startFromOrigin={false}
        onEnvModeChange={vi.fn()}
        worktreePath={null}
        branch={null}
        primaryBranch={null}
      />,
    ),
  );
}

it("keeps a disabled control in the strip while repositories load", async () => {
  await render(true);
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.disabled).toBe(true);
  expect(trigger.textContent).toContain("Finding repositories…");
  expect(trigger.getAttribute("aria-label")).toBe("Finding repositories");
  expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
});

it("opens from the keyboard, closes on Escape, and returns focus to the trigger", async () => {
  await render(false);
  const trigger = page.getByRole("button", { name: "movitera · 2 repositories" });
  await expect.element(trigger).toHaveAttribute("data-composer-shortcut", "composer.repositories");

  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByLabelText("Repositories", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add a repository" })).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull());
  expect(document.activeElement).toBe(trigger.element());
});

it("moves focus to Add a repository after removing one with the keyboard", async () => {
  await render(false);
  const trigger = page.getByRole("button", { name: "movitera · 2 repositories" });
  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Add a repository" })).toBeVisible();

  const remove = page.getByRole("button", { name: "Remove movitera-web" });
  (remove.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Add a repository" }).element(),
    ),
  );
});
