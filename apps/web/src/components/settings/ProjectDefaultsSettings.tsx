import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceId,
  type WorktreeSubmodules,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  effectiveDefaultModelSelectionChain,
  isSameChainEntry,
} from "@t3tools/shared/modelSelectionChain";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  defaultModelSelectionsAreMixed,
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { basename, repositoriesSummary } from "../../workspace/workspaceModel";
import { firstManagedDenial } from "../../state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

export function ProjectDefaultsSettings({ category }: { category: ProjectSettingsCategory }) {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const clientSettings = useClientSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const storedSelection =
    settings.defaultModelSelection === null
      ? resolveProjectDefaultProviderModelSelection(providers, settings, target?.projectId ?? null)
      : resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const selection = storedSelection
    ? resolveEffectiveDefaultModelSelection(settings, providers, storedSelection)
    : null;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const traitsPickerFor = (value: ModelSelection, onChange: (next: ModelSelection) => void) => {
    const instance = entries.find((entry) => entry.instanceId === value.instanceId);
    return instance ? (
      <TraitsPicker
        provider={instance.driverKind}
        models={instance.models}
        model={value.model}
        modelOptions={value.options ?? []}
        allowPromptInjectedEffort={false}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(value.instanceId, value.model, options))
        }
      />
    ) : null;
  };
  const mixedModel = defaultModelSelectionsAreMixed(
    clientSettings,
    targets.map((candidate) => ({
      projectId: candidate.projectId,
      settings: candidate.settings,
      providers: providersByEnvironment.get(candidate.environmentId) ?? EMPTY_SERVER_PROVIDERS,
    })),
  );
  const automaticModel =
    targets.length > 0 &&
    targets.every((candidate) => candidate.settings.defaultModelSelection === null);
  const mixedChain = useScopedSettingsMixed(["defaultModelSelectionChain"]);
  const chain = effectiveDefaultModelSelectionChain(settings);
  const mixedFallback = useScopedSettingsMixed(["fallbackModelSelection"]);
  const fallbackSelection = settings.fallbackModelSelection ?? selection;
  const fallbackModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    fallbackSelection?.instanceId,
    fallbackSelection?.model,
  );
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedRepositories = useScopedSettingsMixed(["workspaceRepositories"]);
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedAgentCredits = useScopedSettingsMixed(["removeAgentCreditsOnMerge"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const effortDisabledReason = selection
    ? modelDisabledReason(selection.instanceId, selection.model)
    : null;

  const setChain = (next: readonly ModelSelection[]) => {
    for (const entry of next) {
      // A saved entry that later became unavailable must not block edits to its siblings.
      // Mixed chains are exempt: a saved entry here may be new to another environment.
      if (!mixedChain && chain.some((saved) => isSameChainEntry(saved, entry))) continue;
      const reason = modelDisabledReason(entry.instanceId, entry.model);
      if (reason) {
        toastManager.add({ type: "error", title: "Default model not saved", description: reason });
        return;
      }
    }
    updateSettings({
      defaultModelSelection: next[0] ?? null,
      defaultModelSelectionChain: [...next],
    });
  };

  const setModel = (value: ModelSelection | null) => {
    if (value === null) {
      setChain([]);
      return;
    }
    setChain([value, ...chain.slice(1).filter((entry) => !isSameChainEntry(entry, value))]);
  };

  const addFallback = (value: ModelSelection) => {
    // With no saved chain the picker above shows the automatic pick; pin it
    // as the head so the new entry lands behind it instead of replacing it.
    const base = chain.length === 0 && selection ? [selection] : chain;
    if (base.some((entry) => isSameChainEntry(entry, value))) {
      toastManager.add({
        type: "error",
        title: "Fallback not added",
        description: "That account and model are already in the list.",
      });
      return;
    }
    setChain([...base, value]);
  };

  const replaceChainEntry = (index: number, value: ModelSelection) => {
    if (chain.some((entry, entryIndex) => entryIndex !== index && isSameChainEntry(entry, value))) {
      toastManager.add({
        type: "error",
        title: "Fallback not saved",
        description: "That account and model are already in the list.",
      });
      return;
    }
    setChain(chain.map((entry, entryIndex) => (entryIndex === index ? value : entry)));
  };

  const moveChainEntry = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= chain.length) return;
    const next = [...chain];
    const [entry] = next.splice(index, 1);
    if (entry) next.splice(target, 0, entry);
    setChain(next);
  };

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection", "defaultModelSelectionChain"]}
      mixed={mixedModel || mixedChain}
      id="default-model"
      title="Model"
      description={
        isProjectScope
          ? "Model for new threads in this project."
          : !unavailable && modelSource !== "project" && automaticModel
            ? "Default model for new threads, selected automatically. Projects can override it."
            : "Default model for new threads. Projects can override it."
      }
      status={
        mixedModel
          ? `${automaticModel ? "Automatic defaults differ." : "Defaults differ."} Select one environment or choose a shared model to edit effort.`
          : (effortDisabledReason ??
            (!unavailable && !mixedChain && modelSource !== "project" && chain.length === 0
              ? "Automatic"
              : undefined))
      }
      resetAction={
        chain.length > 0 ? (
          <SettingResetButton label="default model" onClick={() => setModel(null)} />
        ) : null
      }
      control={
        selection && activeEntry ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel || mixedChain
                ? { triggerLabel: automaticModel ? "Automatic (mixed)" : "Mixed" }
                : {})}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            {!mixedModel && !mixedChain && !effortDisabledReason
              ? traitsPickerFor(selection, setModel)
              : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {mixedModel ? "Mixed" : "No providers available"}
          </span>
        )
      }
    />
  );
  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    if (representative)
      void navigate({
        to: "/settings/providers",
        search: { environmentId: representative.environmentId, instanceId },
      });
  };
  const fallbackRow =
    selection && !mixedModel && !mixedChain ? (
      <SettingsRow
        serverScoped
        settingKeys={["defaultModelSelectionChain"]}
        mixed={mixedChain}
        id="default-model-fallbacks"
        title="Fallback models"
        description="For new threads, T3 tries these in order when an earlier account is out of usage. Accounts that do not report limits are always tried."
        control={
          <div className="flex min-w-0 flex-col items-end gap-1.5">
            {chain.slice(1).map((entry, offset) => {
              const index = offset + 1;
              return (
                <div
                  key={`${entry.instanceId}:${entry.model}:${index}`}
                  className="flex min-w-0 flex-wrap items-center justify-end gap-1"
                >
                  <ProviderModelPicker
                    environmentId={representative?.environmentId ?? null}
                    activeInstanceId={entry.instanceId}
                    model={entry.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={getCustomModelOptionsByInstance(
                      settings,
                      providers,
                      entry.instanceId,
                      entry.model,
                    )}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    getModelDisabledReason={modelDisabledReason}
                    onOpenProviderSetup={openProviderSetup}
                    onInstanceModelChange={(instanceId, model) =>
                      replaceChainEntry(index, createModelSelection(instanceId, model))
                    }
                  />
                  {modelDisabledReason(entry.instanceId, entry.model)
                    ? null
                    : traitsPickerFor(entry, (next) => replaceChainEntry(index, next))}
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Move fallback ${index} up`}
                    onClick={() => moveChainEntry(index, -1)}
                  >
                    <ArrowUpIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Move fallback ${index} down`}
                    disabled={index === chain.length - 1}
                    onClick={() => moveChainEntry(index, 1)}
                  >
                    <ArrowDownIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Remove fallback ${index}`}
                    onClick={() => setChain(chain.filter((_, entryIndex) => entryIndex !== index))}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              );
            })}
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerLabel="Add fallback"
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={openProviderSetup}
              onInstanceModelChange={(instanceId, model) =>
                addFallback(createModelSelection(instanceId, model))
              }
            />
          </div>
        }
      />
    ) : null;
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title="Workspace"
      description={
        isProjectScope
          ? "Where new threads in this project start."
          : "Where new threads start. Projects and their t3.json can override it."
      }
      resetAction={
        !isProjectScope && settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label="default workspace"
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedWorkspace ? null : (effective?.defaultThreadEnvMode ?? null)}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Default workspace">
            <SelectValue>
              {(value: string | null) =>
                value === "local" || value === "worktree"
                  ? resolveEnvModeLabel(value)
                  : unavailable
                    ? "Unavailable"
                    : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
            <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

  const repositoriesRow = isProjectScope ? (
    <SettingsRow
      serverScoped
      settingKeys={["workspaceRepositories"]}
      mixed={mixedRepositories}
      id={searchableSetting("thread-repositories").id}
      title="Repositories"
      description="Repositories new threads in this project start with. Choose them in the repositories popover under the composer, then check “Use for new threads in this project”."
      control={
        <span className="truncate text-muted-foreground text-sm">
          {mixedRepositories
            ? "Mixed"
            : settings.workspaceRepositories.length === 0
              ? "Not saved"
              : repositoriesSummary(
                  settings.workspaceRepositories.map((repository) => basename(repository.path)),
                )}
        </span>
      }
    />
  ) : null;

  const singleFallbackRow = !isProjectScope ? (
    <SettingsRow
      serverScoped
      settingKeys={["fallbackModelSelection"]}
      mixed={mixedFallback}
      {...searchableSetting("fallback-model")}
      description="Used for new threads when the default model's provider is out of usage."
      resetAction={
        mixedFallback || settings.fallbackModelSelection !== null ? (
          <SettingResetButton
            label="fallback model"
            onClick={() => updateSettings({ fallbackModelSelection: null })}
          />
        ) : null
      }
      control={
        fallbackSelection ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={fallbackSelection.instanceId}
              model={fallbackSelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={fallbackModelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Fallback model"
              {...(mixedFallback
                ? { triggerLabel: "Mixed" }
                : settings.fallbackModelSelection === null
                  ? { triggerLabel: "None" }
                  : {})}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) => {
                const reason = modelDisabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: "Fallback model not saved",
                    description: reason,
                  });
                  return;
                }
                updateSettings({ fallbackModelSelection: createModelSelection(instanceId, model) });
              }}
            />
            {settings.fallbackModelSelection !== null && !mixedFallback
              ? traitsPickerFor(fallbackSelection, (next) =>
                  updateSettings({ fallbackModelSelection: next }),
                )
              : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No providers available</span>
        )
      }
    />
  ) : null;

  return (
    <SettingsSection
      id={category === "source-control" ? "source-control-defaults" : "project-defaults"}
      title={category === "source-control" ? "Repositories" : "New threads"}
    >
      {category === "project" ? (
        <>
          {modelRow}
          {fallbackRow}
          {workspaceRow}
          {repositoriesRow}
        </>
      ) : category === "general" ? (
        <>
          {modelRow}
          {fallbackRow}
          {singleFallbackRow}
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            description={
              isProjectScope
                ? "Permissions for new threads in this project."
                : "Default permissions for new threads. Projects can override them."
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label="default permissions"
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default permissions">
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? "Mixed"
                      : runtimeModeConfig[settings.defaultRuntimeMode].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    const managedReason = firstManagedDenial(
                      connectedEnvironments.map(
                        (environment) => environment.serverConfig?.managedPolicy,
                      ),
                      (policy) => managedRuntimeModeDenial(policy, mode),
                    );
                    return (
                      <SelectItem
                        key={mode}
                        value={mode}
                        disabled={managedReason !== undefined}
                        className="min-w-64"
                      >
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {option.label}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {managedReason ?? option.description}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          {workspaceRow}
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title="Automatically pull"
            description={
              isProjectScope
                ? "Keeps this project's default branch current when the checkout has no local changes or commits."
                : "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it."
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label="default automatic pull"
                  tooltip="Reset automatic pull to off"
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Default automatic pull"
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["removeAgentCreditsOnMerge"]}
            mixed={mixedAgentCredits}
            {...searchableSetting("remove-agent-credits-on-merge")}
            description="Remove recognized agent credit lines from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits."
            resetAction={
              settings.removeAgentCreditsOnMerge ? (
                <SettingResetButton
                  label="agent credit removal"
                  tooltip="Keep agent credits"
                  onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Remove agent credits when merging"
                mixed={mixedAgentCredits}
                checked={mixedAgentCredits ? false : settings.removeAgentCreditsOnMerge}
                onCheckedChange={(enabled) =>
                  updateSettings({ removeAgentCreditsOnMerge: enabled })
                }
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? "Pull requests in this project start with this method."
                : "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device."
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label="default merge method"
                  tooltip="Reset to last selected"
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default pull request merge method">
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                        : value === "last"
                          ? "Last selected"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">Last selected</SelectItem>
                  <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                  <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                  <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

export function WorktreeSubmodulesRow() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreeSubmodules"]}
      mixed={mixedSubmodules}
      {...searchableSetting("worktree-submodules")}
      description={
        isProjectScope
          ? "How new worktrees in this project populate git submodules."
          : "How new worktrees populate git submodules. Projects and their t3.json can override it."
      }
      resetAction={
        !isProjectScope && settings.worktreeSubmodules !== null ? (
          <SettingResetButton
            label="worktree submodules"
            onClick={() => updateSettings({ worktreeSubmodules: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedSubmodules ? null : (effective?.worktreeSubmodules ?? null)}
          onValueChange={(value) => {
            if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Worktree submodules">
            <SelectValue>
              {(value: string | null) =>
                isWorktreeSubmodules(value)
                  ? WORKTREE_SUBMODULES_LABELS[value]
                  : unavailable
                    ? "Unavailable"
                    : "Mixed"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WORKTREE_SUBMODULES_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {WORKTREE_SUBMODULES_LABELS[option]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
