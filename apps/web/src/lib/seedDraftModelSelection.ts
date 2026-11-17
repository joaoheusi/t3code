import type { ScopedProjectRef } from "@t3tools/contracts";
import {
  limitedInstanceIdsFromFailures,
  resolveDefaultModelSelectionForNewThread,
} from "@t3tools/shared/modelSelectionChain";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { readProject, readThreadShells } from "../state/entities";
import { readEnvironment, readEnvironmentProviders } from "../state/environments";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

/** Gives a draft that moved project or machine the model a new thread there would start with. */
export function seedDraftModelSelection(draftId: DraftId, projectRef: ScopedProjectRef): void {
  const store = useComposerDraftStore.getState();
  if (hasExplicitComposerModelSelection(store.getComposerDraft(draftId))) return;
  store.applyStickyState(draftId);
  const project = readProject(projectRef);
  const settings = readEnvironment(projectRef.environmentId)?.serverConfig?.settings;
  const providers = readEnvironmentProviders(projectRef.environmentId) ?? [];
  const projectSettings = settings
    ? resolveProjectSettings(settings, projectRef.projectId, project ?? undefined).settings
    : null;
  const defaultSelection = projectSettings
    ? projectSettings.defaultModelSelection
    : (project?.defaultModelSelection ?? null);
  // The fork's ordered chain walks past exhausted entries first; the upstream
  // single fallback then covers a chain head that stays exhausted.
  const chainSelection = projectSettings
    ? resolveDefaultModelSelectionForNewThread({
        settings: projectSettings,
        providers,
        limitedInstanceIds: limitedInstanceIdsFromFailures(
          readThreadShells().flatMap((shell) =>
            shell.environmentId === projectRef.environmentId &&
            shell.runtime?.lastErrorClass === "usage_limit"
              ? [
                  {
                    instanceId: shell.providerInstanceId,
                    usageLimitResetAt: shell.runtime.usageLimitResetAt,
                  },
                ]
              : [],
          ),
        ),
      })
    : null;
  const resolution = resolveNewThreadModelSelection({
    defaultSelection:
      chainSelection ??
      defaultSelection ??
      (useComposerDraftStore.getState().stickyActiveProvider !== null || !settings
        ? null
        : resolveProjectDefaultProviderModelSelection(providers, settings, projectRef.projectId)),
    fallbackSelection: settings?.fallbackModelSelection ?? null,
    providers,
    ...(settings ? { settings } : {}),
    projectId: projectRef.projectId,
    now: Date.now(),
  });
  const selection = resolution.fallback
    ? resolution.selection
    : (chainSelection ?? defaultSelection);
  if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
}
