import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ProviderModelPicker as ProviderModelPickerType } from "../chat/ProviderModelPicker";
import { toastManager } from "../ui/toast";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

const environmentId = EnvironmentId.make("environment-1");
const primary = ProviderInstanceId.make("claude-primary");
const secondary = ProviderInstanceId.make("claude-secondary");

const provider = (instanceId: ProviderInstanceId): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "opus",
      name: "Opus",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["Medium", "High"].map((id) => ({
              id,
              label: id,
              isDefault: id === "Medium",
            })),
          },
        ],
      },
    },
  ],
});
const providers = [provider(primary), provider(secondary)];

const mocks = vi.hoisted(() => ({
  chain: [] as ModelSelection[],
  updateSettings: vi.fn(),
}));

const settings = () => ({
  ...DEFAULT_CLIENT_SETTINGS,
  ...DEFAULT_SERVER_SETTINGS,
  defaultModelSelection: mocks.chain[0] ?? null,
  defaultModelSelectionChain: mocks.chain,
});

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const target = { environmentId, projectId: null, settings: settings() };
    return {
      scope: { kind: "all" },
      target,
      targets: [target],
      environments: [],
      connectedEnvironments: [{ environmentId }],
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => settings()) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: (() => "environment") as never,
  useUpdateScopedSettings: () => mocks.updateSettings,
}));
vi.mock(import("./useScopedModelAvailability"), () => ({
  useScopedModelDisabledReason: () => () => null,
}));
// The real picker's virtualized list has no height in tests; a click re-picks the current model.
vi.mock(import("../chat/ProviderModelPicker"), () => ({
  ProviderModelPicker: (({ activeInstanceId, model, triggerLabel, onInstanceModelChange }) => (
    <button type="button" onClick={() => onInstanceModelChange(activeInstanceId, model)}>
      {triggerLabel ?? model}
    </button>
  )) as typeof ProviderModelPickerType,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set([environmentId]),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId, serverConfig: {} }],
  })) as never,
  useEnvironmentProviders: () => new Map([[environmentId, providers]]),
}));

function setup(chain: readonly ModelSelection[]) {
  mocks.chain = [...chain];
  mocks.updateSettings.mockClear();
}

const head = createModelSelection(primary, "opus", [{ id: "effort", value: "High" }]);

describe("ProjectDefaultsSettings fallback models", () => {
  it("saves effort on the fallback entry and leaves the head alone", async () => {
    setup([head, createModelSelection(secondary, "opus")]);
    await using _screen = await render(<ProjectDefaultsSettings category="general" />);

    await userEvent.click(page.getByRole("button", { name: "Medium" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "High" }));

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      defaultModelSelection: head,
      defaultModelSelectionChain: [
        head,
        createModelSelection(secondary, "opus", [{ id: "effort", value: "High" }]),
      ],
    });
  });

  it("rejects a fallback that differs from an existing entry only by effort", async () => {
    setup([head]);
    await using _screen = await render(<ProjectDefaultsSettings category="general" />);
    using toast = vi.spyOn(toastManager, "add");

    await userEvent.click(page.getByRole("button", { name: "Add fallback" }));

    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Fallback not added" }));
  });
});
