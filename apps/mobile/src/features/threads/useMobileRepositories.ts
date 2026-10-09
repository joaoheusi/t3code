import { useEffect, useMemo, useRef } from "react";
import { Alert } from "react-native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  draftRepositoryFrom,
  draftRepositoryFromDefault,
  REPOSITORY_LIMIT,
  repositoryDefaultFrom,
  topLevelRepositories,
} from "@t3tools/client-runtime/workspaceModel";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
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

/**
 * Adds the projects picked together with this draft's project as its other repositories.
 * Runs once per draft and pick, after discovery decides whether the project is a folder.
 */
export function useInitialRepositories(
  project: EnvironmentProject | null,
  draftKey: string | null,
  initial: { readonly projectId: string; readonly paths: readonly string[] } | undefined,
) {
  const choice = useMobileRepositories(project, draftKey);
  const inspect = useAtomCommand(forkWorkspace.inspect, { reportFailure: false });
  const applied = useRef<string | null>(null);
  const ready =
    !!initial &&
    initial.paths.length > 0 &&
    !!project &&
    !!draftKey &&
    project.id === initial.projectId &&
    choice.supported &&
    (!choice.discovery.isPending || !!choice.discovery.data);
  const key = ready ? `${draftKey}:${initial.paths.join("\n")}` : null;
  useEffect(() => {
    if (!key || !project || applied.current === key) return;
    applied.current = key;
    const base = choice.selection;
    void (async () => {
      const results = await Promise.all(
        initial!.paths.map((path) =>
          inspect({ environmentId: project.environmentId, input: { path } }),
        ),
      );
      const seen = new Set(base.repositories.map((entry) => entry.commonDir));
      const added = results.flatMap((result) => {
        if (result._tag === "Failure" || seen.has(result.value.commonDir)) return [];
        seen.add(result.value.commonDir);
        return [
          {
            ...repositoryDefaultFrom(draftRepositoryFrom(result.value, result.value.path)),
            branch: result.value.branch,
            head: result.value.head,
          },
        ];
      });
      const limit = base.folder ? REPOSITORY_LIMIT : REPOSITORY_LIMIT - 1;
      choice.setSelection({
        ...base,
        repositories: [...base.repositories, ...added].slice(0, limit),
      });
      const failed = results.filter((result) => result._tag === "Failure").length;
      if (failed > 0)
        Alert.alert(
          failed === 1 ? "A project was not added" : `${failed} projects were not added`,
          "They could not be read as repositories on this machine.",
        );
    })();
    // Runs once per key; the selection is read at that moment on purpose.
  }, [key]);
}
