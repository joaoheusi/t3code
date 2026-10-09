import type { ThreadWorkspace, VcsStatusResult } from "@t3tools/contracts";
import { resolveQuickAction, type GitQuickAction } from "../components/GitActionsControl.logic";

/** Use each recorded checkout, never the parent folder of a repository set. */
export function quickActionGitTargets(
  workspace: ThreadWorkspace | null | undefined,
  cwd: string | null,
) {
  if (workspace) {
    return workspace.bindings.map((binding) => ({
      cwd: binding.checkoutPath,
      label: binding.label,
      unavailable:
        binding.state === "ready" ? null : (binding.error ?? "Repository is not ready yet."),
    }));
  }
  return cwd
    ? [{ cwd, label: cwd.split(/[\\/]/).findLast(Boolean) ?? cwd, unavailable: null }]
    : [];
}

export function resolveQuickActionGit(
  status: VcsStatusResult | null,
  busy: boolean,
): GitQuickAction {
  if (status && !status.isRepo) {
    return {
      label: "Git unavailable",
      kind: "show_hint",
      disabled: true,
      hint: "This folder is not a Git repository.",
    } as const;
  }
  return resolveQuickAction(
    status,
    busy,
    status?.isDefaultRef ?? false,
    status?.hasPrimaryRemote ?? false,
  );
}

/** A refreshed status may offer a different write. Ask again instead of silently changing it. */
export function sameQuickActionGit(
  before: ReturnType<typeof resolveQuickActionGit>,
  after: ReturnType<typeof resolveQuickActionGit>,
  beforeBranch: string | null,
  afterBranch: string | null,
) {
  return (
    beforeBranch === afterBranch &&
    before.kind === after.kind &&
    before.action === after.action &&
    before.label === after.label
  );
}
