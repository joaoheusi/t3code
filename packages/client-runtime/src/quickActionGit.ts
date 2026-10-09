import type { ThreadWorkspace, VcsStatusResult, GitStackedAction } from "@t3tools/contracts";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

function resolveChangeRequestTerminology(status: VcsStatusResult | null) {
  return status?.sourceControlProvider
    ? getChangeRequestTerminology(status.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    }
    return {
      label: `Commit, push & ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      return {
        label: "Publish repository",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: "Commit",
          disabled: true,
          kind: "show_hint",
          hint: "Branch is up to date. No action needed.",
        };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "Sync ref",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  // An open change request is surfaced by the standalone attribution row in the
  // details panel, so the action button rests in its disabled up-to-date state.
  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

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
  if (status?.hasUpstream && status.behindCount > 0 && status.hasWorkingTreeChanges) {
    return {
      label: "Sync branch",
      kind: "show_hint",
      disabled: true,
      hint: "Commit or stash changes, then integrate remote commits before pushing.",
    };
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

export type QuickActionGitRepository = ReturnType<typeof quickActionGitTargets>[number] & {
  readonly status: VcsStatusResult | null;
  readonly action: GitQuickAction;
};

const commits = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;

/** Pull compares the tracked branch. Base changes are informative, never an implicit merge. */
export function describeQuickActionGit(repository: QuickActionGitRepository): string {
  const { status, action, unavailable } = repository;
  if (unavailable) return unavailable;
  if (!status) return "Checking repository status…";
  if (!status.isRepo) return "This folder is not a Git repository.";
  const parts = [status.refName ?? "Detached HEAD"];
  const upstream = status.upstreamRef ?? "tracked remote branch";
  if (status.hasWorkingTreeChanges) {
    const count = status.workingTree.files.length;
    parts.push(count ? `${count} changed file${count === 1 ? "" : "s"}` : "Uncommitted changes");
  }
  if (status.behindCount > 0) parts.push(`${commits(status.behindCount)} to pull from ${upstream}`);
  if (status.aheadCount > 0) parts.push(`${commits(status.aheadCount)} to push`);
  if (status.baseComparison && status.baseComparison.ref !== status.upstreamRef) {
    const { ref, behindCount } = status.baseComparison;
    parts.push(
      behindCount > 0 ? `${ref} has ${commits(behindCount)} not here` : `Includes latest ${ref}`,
    );
  }
  if (status.pr?.state === "open") parts.push(`PR #${status.pr.number} open`);
  else if (action.action === "commit_push_pr" || action.action === "create_pr")
    parts.push("No open PR");
  if (action.hint) parts.push(action.hint);
  return parts.join(" · ");
}

/** Exactly one top-level entry, regardless of repository count or mixed operations. */
export function summarizeQuickActionGit(repositories: readonly QuickActionGitRepository[]) {
  const only = repositories[0];
  if (repositories.length === 1 && only)
    return {
      label: only.action.label,
      description: `${only.label} · ${describeQuickActionGit(only)}`,
      disabled: !!only.unavailable || only.action.disabled,
    };
  const changed = repositories.reduce(
    (sum, repository) => sum + (repository.status?.workingTree.files.length ?? 0),
    0,
  );
  const ahead = repositories.reduce(
    (sum, repository) => sum + (repository.status?.aheadCount ?? 0),
    0,
  );
  const behind = repositories.reduce(
    (sum, repository) => sum + (repository.status?.behindCount ?? 0),
    0,
  );
  const pending = repositories.filter(
    (repository) => !repository.status && !repository.unavailable,
  ).length;
  const unavailable = repositories.filter(
    (repository) =>
      repository.unavailable ||
      (repository.action.disabled &&
        repository.action.hint !== "Branch is up to date. No action needed."),
  ).length;
  const parts = [`${repositories.length} repositories`];
  if (changed) parts.push(`${changed} changed file${changed === 1 ? "" : "s"}`);
  if (ahead) parts.push(`${commits(ahead)} to push`);
  if (behind) parts.push(`${commits(behind)} to pull`);
  if (pending) parts.push("Checking status…");
  else if (unavailable) parts.push(`${unavailable} need attention`);
  if (parts.length === 1) parts.push("Choose a repository to see its next action");
  return {
    label: "Sync repositories",
    description: repositories.length === 0 ? "Open a repository first" : parts.join(" · "),
    disabled: repositories.length === 0,
  };
}
