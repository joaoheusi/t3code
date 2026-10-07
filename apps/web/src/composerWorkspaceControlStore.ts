import { create } from "zustand";

import type { EnvMode } from "./components/BranchToolbar.logic";

/**
 * The open composer's workspace menu while it accepts a choice. Shortcuts and
 * the command palette read it, so they offer a workspace switch exactly when
 * the menu itself would.
 */
export interface ComposerWorkspaceControl {
  /** The existing worktree that choosing "local" keeps, if any. */
  readonly activeWorktreePath: string | null;
  readonly selectEnvMode: (mode: EnvMode) => void;
}

export const useComposerWorkspaceControlStore = create<{
  control: ComposerWorkspaceControl | null;
}>()(() => ({ control: null }));

/** Publishes `control` until the returned cleanup runs. */
export function publishComposerWorkspaceControl(control: ComposerWorkspaceControl): () => void {
  useComposerWorkspaceControlStore.setState({ control });
  return () => {
    // A newer composer may have published since; leave its control in place.
    if (useComposerWorkspaceControlStore.getState().control !== control) return;
    useComposerWorkspaceControlStore.setState({ control: null });
  };
}
