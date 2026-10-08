import { useMemo } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  draftRepositoryFrom,
  draftRepositoryFromDefault,
  repositoryDefaultFrom,
  topLevelRepositories,
} from "@t3tools/client-runtime/workspaceModel";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { forkWorkspace } from "../../state/forkWorkspace";
import {
  useComposerDraft,
  updateComposerDraftSettings,
  getComposerDraftSnapshot,
} from "../../state/use-composer-drafts";
import type { MobileRepositorySelection } from "../../state/mobile-repository-selection";

export function useMobileRepositories(project: EnvironmentProject | null, draftKey: string | null) {
  const config = useEnvironmentServerConfig(project?.environmentId ?? null);
  const draft = useComposerDraft(draftKey);
  const version = config?.environment.capabilities.forkMultiRepoVersion ?? 0;
  const supported =
    version >= 2 && !!project && !isScratchProject(project, config?.scratchWorkspaceRoot);
  const discovery = useEnvironmentQuery(
    supported
      ? forkWorkspace.discoverQuery({
          environmentId: project.environmentId,
          input: { root: project.workspaceRoot, depth: project.repositoryIdentity ? 0 : 3 },
        })
      : null,
  );
  const found = useMemo(
    () => topLevelRepositories(discovery.data?.repositories ?? []),
    [discovery.data],
  );
  const selection = useMemo((): MobileRepositorySelection => {
    if (draft.repositorySelection) return draft.repositorySelection;
    const primary = found.find((entry) => entry.path === project?.workspaceRoot);
    const saved = project
      ? config?.settings.projectSettingsOverrides[project.id]?.workspaceRepositories
      : undefined;
    return {
      folder: !primary && found.length > 0,
      repositories:
        (saved && saved.length > 0 ? saved : undefined) ??
        (primary
          ? []
          : found.slice(0, 20).map((entry) => ({
              ...repositoryDefaultFrom(draftRepositoryFrom(entry, entry.path)),
              branch: entry.branch,
              head: entry.head,
            }))),
    };
  }, [draft.repositorySelection, found, project, config]);
  return {
    supported,
    selection,
    discovery,
    foundCount: found.length,
    repositories: selection.repositories.map((entry) => ({
      ...draftRepositoryFromDefault(entry),
      branch: entry.branch ?? null,
      head: entry.head ?? "",
    })),
    setSelection: (value: MobileRepositorySelection) => {
      if (!draftKey) return;
      const owner = getComposerDraftSnapshot(draftKey).project;
      if (
        owner &&
        (owner.projectId !== project?.id || owner.environmentId !== project.environmentId)
      )
        return;
      updateComposerDraftSettings(draftKey, { repositorySelection: value });
    },
  };
}
