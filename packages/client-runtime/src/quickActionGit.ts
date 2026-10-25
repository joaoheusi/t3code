import type { ThreadWorkspace, VcsStatusResult, GitStackedAction } from "@t3tools/contracts";
import { sourceControlClients } from "./sourceControlClients.ts";
import { requiresDefaultBranchConfirmation } from "./state/gitActions.ts";

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
  /** Waiting or no work to do; the disabled action needs no user intervention. */
  idle?: boolean;
}

function resolveChangeRequestTerminology(status: VcsStatusResult | null) {
  return sourceControlClients.get(status?.sourceControlProvider?.kind).changeRequest;
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git action in progress.",
      idle: true,
    };
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
          idle: true,
        };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
        idle: true,
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
      idle: true,
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
    idle: true,
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
  const terminology = resolveChangeRequestTerminology(status);
  if (status.pr?.state === "open")
    parts.push(`${terminology.shortLabel} #${status.pr.number} open`);
  else if (action.action === "commit_push_pr" || action.action === "create_pr")
    parts.push(`No open ${terminology.shortLabel}`);
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
      repository.unavailable || (repository.action.disabled && !repository.action.idle),
  ).length;
  const parts = [`${repositories.length} repositories`];
  if (changed) parts.push(`${changed} changed file${changed === 1 ? "" : "s"}`);
  if (ahead) parts.push(`${commits(ahead)} to push`);
  if (behind) parts.push(`${commits(behind)} to pull`);
  // Every repository is waiting or has no work, so there is nothing to choose.
  const settled =
    repositories.length > 0 &&
    !pending &&
    repositories.every((repository) => !repository.unavailable && repository.action.idle);
  if (pending) parts.push("Checking status…");
  else if (unavailable) parts.push(`${unavailable} need attention`);
  if (parts.length === 1) parts.push(settled ? "Up to date" : "Choose repositories to sync");
  return {
    label: "Sync repositories",
    description: repositories.length === 0 ? "Open a repository first" : parts.join(" · "),
    disabled: repositories.length === 0 || settled,
  };
}

/** A repository's row among several; one with no work to do doesn't name an action. */
export const quickActionGitRowTitle = (repository: QuickActionGitRepository) =>
  repository.action.idle ? repository.label : `${repository.label}: ${repository.action.label}`;

/** One selected repository after a fresh status check, carrying the action it will run. */
export interface QuickActionGitSelection {
  readonly label: string;
  readonly status: VcsStatusResult;
  readonly action: GitQuickAction;
}

export type QuickActionGitBatch<T extends QuickActionGitSelection> =
  | { readonly kind: "run"; readonly confirmations: readonly T[] }
  | { readonly kind: "publish"; readonly repository: T }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Gates a batch before any write. Publishing is an interactive per-repository
 * step, so it only proceeds alone. Repositories about to write to their
 * default ref are collected for one combined confirmation.
 */
export function planQuickActionGitBatch<T extends QuickActionGitSelection>(
  selected: readonly T[],
): QuickActionGitBatch<T> {
  const publish = selected.find((repository) => repository.action.kind === "open_publish");
  if (publish) {
    return selected.length === 1
      ? { kind: "publish", repository: publish }
      : {
          kind: "blocked",
          reason: `${publish.label} has no remote yet. Publish it on its own, then run the rest.`,
        };
  }
  return {
    kind: "run",
    confirmations: selected.filter(
      (repository) =>
        repository.action.action !== undefined &&
        requiresDefaultBranchConfirmation(
          repository.action.action,
          repository.status.isDefaultRef ?? false,
        ),
    ),
  };
}

/** "web (main), api (main)" for the combined default-ref confirmation. */
export const describeQuickActionGitConfirmations = (
  confirmations: readonly QuickActionGitSelection[],
) =>
  confirmations
    .map((repository) => `${repository.label} (${repository.status.refName ?? "default ref"})`)
    .join(", ");
