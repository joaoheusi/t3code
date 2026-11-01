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
  // A project with no repository identity is probably a folder, so hold its row until the scan ends.
  if (!discovery.data) return { loading: true, selected: [], options: [] };
  const found = topLevelRepositories(discovery.data.repositories);
  if (found.some((repository) => repository.path === project.workspaceRoot)) return null;
  return {
    loading: false,
    ...folderRepositoryChoice({
      found,
      saved: config?.settings.projectSettingsOverrides[project.id]?.workspaceRepositories ?? [],
      chosen,
    }),
  };
}
