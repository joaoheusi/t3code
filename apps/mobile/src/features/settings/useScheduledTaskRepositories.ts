import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  FOLDER_DISCOVERY_DEPTH,
  folderRepositoryChoice,
  topLevelRepositories,
} from "@t3tools/client-runtime/workspaceModel";

import { useEnvironmentServerConfig } from "../../state/entities";
import { forkWorkspace } from "../../state/forkWorkspace";
import { useEnvironmentQuery } from "../../state/query";

/** A folder project's repositories, or null when the project is its own repository. */
export function useScheduledTaskRepositories(
  project: EnvironmentProject | null,
  chosen: readonly string[] | null,
) {
  const config = useEnvironmentServerConfig(project?.environmentId ?? null);
  const supported =
    (config?.environment.capabilities.forkMultiRepoVersion ?? 0) >= 3 &&
    !!project &&
    !project.repositoryIdentity &&
    !isScratchProject(project, config?.scratchWorkspaceRoot);
  const discovery = useEnvironmentQuery(
    supported
      ? forkWorkspace.discoverQuery({
          environmentId: project.environmentId,
          input: { root: project.workspaceRoot, depth: FOLDER_DISCOVERY_DEPTH },
        })
      : null,
  );
  if (!supported) return null;
  const state = { loading: false, error: null, retry: discovery.refresh };
  if (!discovery.data) {
    const empty: ReturnType<typeof folderRepositoryChoice> = { selected: [], options: [] };
    // A project with no repository identity is probably a folder, so hold its row until the scan ends.
    return discovery.error !== null && !discovery.isPending
      ? { ...state, ...empty, error: discovery.error }
      : { ...state, ...empty, loading: true };
  }
  const found = topLevelRepositories(discovery.data.repositories);
  if (found.some((repository) => repository.path === project.workspaceRoot)) return null;
  return {
    ...state,
    ...folderRepositoryChoice({
      found,
      saved: config?.settings.projectSettingsOverrides[project.id]?.workspaceRepositories ?? [],
      chosen,
    }),
  };
}
