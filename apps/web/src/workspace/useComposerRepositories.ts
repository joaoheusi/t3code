import {
  type EnvironmentId,
  type ProjectId,
  type ThreadWorkspace,
  type WorkspaceRepositoryDefault,
} from "@t3tools/contracts";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";

import { toastManager } from "../components/ui/toast";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useServerConfigs } from "../state/entities";
import { forkWorkspace } from "../state/forkWorkspace";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  REPOSITORY_LIMIT,
  draftRepositoryFrom,
  draftRepositoryFromBinding,
  draftRepositoryFromDefault,
  repositoryDefaultFrom,
  topLevelRepositories,
  type DraftRepository,
} from "./workspaceModel";
import { useDraftRepositories } from "./workspaceStores";

/** 1: extra repositories beside the project. 2: folder projects and saved defaults too. */
export function useMultiRepositoryVersion(environmentId: EnvironmentId) {
  return useServerConfigs().get(environmentId)?.environment.capabilities.forkMultiRepoVersion ?? 0;
}

const NO_DEFAULTS: readonly WorkspaceRepositoryDefault[] = [];

/**
 * The repositories a composer's thread will start with. The user's own choice wins; a
 * thread whose preparation failed starts from what it recorded; otherwise the project's
 * saved default applies, and a folder project that isn't a repository holds every
 * repository found inside it.
 */
export function useComposerRepositories(input: {
  readonly composerKey: string;
  readonly environmentId: EnvironmentId;
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string } | null;
  readonly isGitRepo: boolean;
  readonly workspace: ThreadWorkspace | undefined;
  /** False once the thread has started, when its repositories are fixed. */
  readonly choosing: boolean;
}) {
  const { environmentId, project, isGitRepo, workspace, choosing } = input;
  const serverConfig = useServerConfigs().get(environmentId);
  const version = serverConfig?.environment.capabilities.forkMultiRepoVersion ?? 0;
  const saved = useEnvironmentSettings(environmentId, (settings) =>
    project
      ? (settings.projectSettingsOverrides[project.id]?.workspaceRepositories ?? NO_DEFAULTS)
      : NO_DEFAULTS,
  );
  // The "No project" scratch folder holds unrelated work, never a folder project.
  const scratchRoot = serverConfig?.scratchWorkspaceRoot ?? null;
  const discovery = useEnvironmentQuery(
    version >= 2 && choosing && !isGitRepo && project && project.workspaceRoot !== scratchRoot
      ? forkWorkspace.discoverQuery({
          environmentId,
          input: { root: project.workspaceRoot, depth: 3 },
        })
      : null,
  );
  const found = topLevelRepositories(discovery.data?.repositories ?? []);
  const chosen = useDraftRepositories(input.composerKey, environmentId, project?.id ?? null);
  const recorded = workspace && ["failed", "cancelled"].includes(workspace.state);
  const repositories = ((): readonly DraftRepository[] => {
    if (chosen) return chosen;
    if (recorded)
      return workspace!.bindings
        .filter((binding) => workspace!.root || binding.id !== workspace!.primaryBindingId)
        .map(draftRepositoryFromBinding);
    if (version >= 2 && saved.length > 0) return saved.map(draftRepositoryFromDefault);
    return found
      .slice(0, REPOSITORY_LIMIT)
      .map((repository) => draftRepositoryFrom(repository, repository.path));
  })();
  return {
    repositories,
    /**
     * Whether the choice can be shown is still unknown: the server's capabilities
     * have not loaded, or the folder is still being scanned for repositories.
     * Callers keep their control mounted but disabled so it does not pop in late.
     */
    loading: Boolean(
      choosing &&
      project &&
      (serverConfig === undefined || (discovery.isPending && discovery.data === null)),
    ),
    /** The project folder isn't a repository, so the thread works in the folder itself. */
    folder: version >= 2 && !isGitRepo && (repositories.length > 0 || found.length > 0),
    foundCount: found.length,
    /** The list is still the default, so changes must first copy it into the draft. */
    untouched: chosen === null,
    saved,
  };
}

/** Saves or clears the repositories a project's new threads start with. */
export function useSaveRepositoryDefault(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  return async (repositories: readonly DraftRepository[] | null) => {
    if (!projectId) return;
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]:
              repositories === null
                ? clearProjectSettingsOverrides(settings, projectId, ["workspaceRepositories"])
                : {
                    ...settings.projectSettingsOverrides[projectId],
                    workspaceRepositories: repositories.map(repositoryDefaultFrom),
                  },
          },
        },
      },
    });
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Couldn't save the project's repositories" });
  };
}
