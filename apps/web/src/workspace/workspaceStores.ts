import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

import type { CheckoutMode, DraftRepository } from "./workspaceModel";

interface DraftRepositorySelection {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repositories: readonly DraftRepository[];
}

interface WorkspaceUiState {
  /** Extra repositories picked for a composer before its thread exists, keyed by composer target. */
  readonly draftRepositories: Record<string, DraftRepositorySelection>;
  /** The message to send once a thread's repositories are ready, keyed by thread. */
  readonly pendingSends: Record<string, { readonly prompt: string }>;
  /** Which repository the diff, files, and Git panels show, keyed by thread. */
  readonly activeRepository: Record<string, string>;
  addDraftRepository: (
    key: string,
    owner: Omit<DraftRepositorySelection, "repositories">,
    repository: DraftRepository,
  ) => void;
  removeDraftRepository: (key: string, id: string) => void;
  setDraftRepositoryMode: (key: string, id: string, mode: CheckoutMode) => void;
  setDraftRepositories: (key: string, selection: DraftRepositorySelection | null) => void;
  setPendingSend: (threadKey: string, prompt: string | null) => void;
  setActiveRepository: (threadKey: string, bindingId: string) => void;
}

const without = <T>(record: Record<string, T>, key: string) => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const useWorkspaceUiStore = create<WorkspaceUiState>()((set) => ({
  draftRepositories: {},
  pendingSends: {},
  activeRepository: {},
  addDraftRepository: (key, owner, repository) =>
    set((state) => {
      const current = state.draftRepositories[key];
      // A selection made on another machine or project never carries over.
      const repositories =
        current?.environmentId === owner.environmentId && current.projectId === owner.projectId
          ? current.repositories
          : [];
      if (repositories.some((entry) => entry.commonDir === repository.commonDir)) return state;
      return {
        draftRepositories: {
          ...state.draftRepositories,
          [key]: { ...owner, repositories: [...repositories, repository] },
        },
      };
    }),
  removeDraftRepository: (key, id) =>
    set((state) => {
      const current = state.draftRepositories[key];
      if (!current) return state;
      const repositories = current.repositories.filter((entry) => entry.id !== id);
      return {
        draftRepositories:
          repositories.length === 0
            ? without(state.draftRepositories, key)
            : { ...state.draftRepositories, [key]: { ...current, repositories } },
      };
    }),
  setDraftRepositoryMode: (key, id, mode) =>
    set((state) => {
      const current = state.draftRepositories[key];
      if (!current) return state;
      return {
        draftRepositories: {
          ...state.draftRepositories,
          [key]: {
            ...current,
            repositories: current.repositories.map((entry) =>
              entry.id === id ? { ...entry, mode } : entry,
            ),
          },
        },
      };
    }),
  setDraftRepositories: (key, selection) =>
    set((state) => ({
      draftRepositories:
        selection === null || selection.repositories.length === 0
          ? without(state.draftRepositories, key)
          : { ...state.draftRepositories, [key]: selection },
    })),
  setPendingSend: (threadKey, prompt) =>
    set((state) => ({
      pendingSends:
        prompt === null
          ? without(state.pendingSends, threadKey)
          : { ...state.pendingSends, [threadKey]: { prompt } },
    })),
  setActiveRepository: (threadKey, bindingId) =>
    set((state) => ({ activeRepository: { ...state.activeRepository, [threadKey]: bindingId } })),
}));

const EMPTY: readonly DraftRepository[] = [];

/** Extra repositories for this composer, if they were picked on this machine and project. */
export function useDraftRepositories(
  key: string,
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): readonly DraftRepository[] {
  return useWorkspaceUiStore((state) => {
    const selection = state.draftRepositories[key];
    return selection &&
      selection.environmentId === environmentId &&
      selection.projectId === projectId
      ? selection.repositories
      : EMPTY;
  });
}

export function readDraftRepositories(
  key: string,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): readonly DraftRepository[] {
  const selection = useWorkspaceUiStore.getState().draftRepositories[key];
  return selection?.environmentId === environmentId && selection.projectId === projectId
    ? selection.repositories
    : EMPTY;
}
