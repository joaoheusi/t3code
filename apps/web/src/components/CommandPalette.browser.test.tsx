import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "./CommandPalette";

const denied = EnvironmentId.make("denied");
const permitted = EnvironmentId.make("permitted");
const allowedAtom = Atom.make(true);
const refusedAtom = Atom.make(false);
const state = vi.hoisted(() => ({ environments: false }));

function environment(environmentId: EnvironmentId, label: string) {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: { os: "linux" }, capabilities: {} } },
    entry: { target: { _tag: "SavedConnectionTarget" } },
  };
}

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => (id === permitted ? allowedAtom : refusedAtom),
      },
    },
  };
});
vi.mock(import("../state/environments"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironments: (() =>
      state.environments
        ? {
            environments: [environment(denied, "A denied"), environment(permitted, "B permitted")],
          }
        : actual.useEnvironments()) as never,
  };
});

function setup() {
  state.environments = false;
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
}

describe("CommandPalette open intents", () => {
  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("offers New scheduled task when any connected environment permits it", async () => {
    setup();
    state.environments = true;
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "scheduled task" });

    await expect
      .element(page.getByRole("option", { name: "New scheduled task" }))
      .toBeInTheDocument();
  });
});
