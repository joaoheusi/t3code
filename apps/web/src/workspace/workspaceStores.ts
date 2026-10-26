import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftRepository } from "./workspaceModel";

interface DraftRepositorySelection {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repositories: readonly DraftRepository[];
}

interface WorkspaceUiState {
  /**
   * Repositories the user chose for a composer before its thread exists, keyed by composer
   * target. An absent key means untouched, so the project's default applies; an empty list
   * is a real choice of none.
   */
  readonly draftRepositories: Record<string, DraftRepositorySelection>;
  /**
   * The message to send once a thread's repositories are ready, keyed by thread. It is queued
   * before setup commits so the banner shows, and sends only once `setupComplete` is set.
   */
  readonly pendingSends: Record<
    string,
    { readonly prompt: string; readonly setupComplete: boolean }
  >;
  /** Which repository the diff, files, and Git panels show, keyed by thread. */
  readonly activeRepository: Record<string, string>;
  addDraftRepository: (
    key: string,
    owner: Omit<DraftRepositorySelection, "repositories">,
    repository: DraftRepository,
  ) => void;
  removeDraftRepository: (key: string, id: string) => void;
  /** Changes how one chosen repository is checked out: its mode, or a new worktree's base. */
  updateDraftRepository: (
    key: string,
    id: string,
    patch: Partial<Pick<DraftRepository, "mode" | "branch" | "startFromOrigin">>,
  ) => void;
  setDraftRepositories: (key: string, selection: DraftRepositorySelection | null) => void;
  setPendingSend: (threadKey: string, prompt: string | null) => void;
  markPendingSendSetupComplete: (threadKey: string) => void;
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
        draftRepositories: { ...state.draftRepositories, [key]: { ...current, repositories } },
      };
    }),
  updateDraftRepository: (key, id, patch) =>
    set((state) => {
      const current = state.draftRepositories[key];
      if (!current) return state;
      return {
        draftRepositories: {
          ...state.draftRepositories,
          [key]: {
            ...current,
            repositories: current.repositories.map((entry) =>
              entry.id === id ? { ...entry, ...patch } : entry,
            ),
          },
        },
      };
    }),
  setDraftRepositories: (key, selection) =>
    set((state) => ({
      draftRepositories:
        selection === null
          ? without(state.draftRepositories, key)
          : { ...state.draftRepositories, [key]: selection },
    })),
  setPendingSend: (threadKey, prompt) =>
    set((state) => ({
      pendingSends:
        prompt === null
          ? without(state.pendingSends, threadKey)
          : { ...state.pendingSends, [threadKey]: { prompt, setupComplete: false } },
    })),
  markPendingSendSetupComplete: (threadKey) =>
    set((state) => {
      const pending = state.pendingSends[threadKey];
      return pending
        ? {
            pendingSends: {
              ...state.pendingSends,
              [threadKey]: { ...pending, setupComplete: true },
            },
          }
        : state;
    }),
  setActiveRepository: (threadKey, bindingId) =>
    set((state) => ({ activeRepository: { ...state.activeRepository, [threadKey]: bindingId } })),
}));

/** The repositories chosen for this composer on this machine and project, or null if untouched. */
export function useDraftRepositories(
  key: string,
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): readonly DraftRepository[] | null {
  return useWorkspaceUiStore((state) => {
    const selection = state.draftRepositories[key];
    return selection &&
      selection.environmentId === environmentId &&
      selection.projectId === projectId
      ? selection.repositories
      : null;
  });
}
