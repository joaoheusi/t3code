import type {
  ThreadWorkspace,
  WorkspaceBinding,
  WorkspaceBindingRequest,
  WorkspaceConfiguration,
  WorkspaceRepository,
  WorkspaceRepositoryDefault,
  WorkspaceRootRequest,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

export type CheckoutMode = WorkspaceBindingRequest["mode"];

/** A repository picked for a draft, validated on its environment but not yet prepared. */
export interface DraftRepository {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly commonDir: string;
  readonly mode: CheckoutMode;
  /** Branch observed when the repository was added; the base for a new worktree. */
  readonly branch: string | null;
  readonly head: string;
  readonly startFromOrigin?: boolean;
}

export const CHECKOUT_MODE_LABEL: Record<CheckoutMode, string> = {
  current: "Current checkout",
  "existing-worktree": "Existing worktree",
  "new-worktree": "New worktree",
};

export const basename = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;

/** A thread holds at most this many repositories. */
export const REPOSITORY_LIMIT = 20;

export const isInsideFolder = (folder: string, path: string) => {
  const separator = folder.includes("\\") ? "\\" : "/";
  return path.startsWith(folder.endsWith(separator) ? folder : folder + separator);
};

/** A linked worktree keeps its own git dir under the repository's common dir. */
export const isLinkedWorktree = (repository: Pick<WorkspaceRepository, "gitDir" | "commonDir">) =>
  repository.gitDir !== repository.commonDir;

/**
 * The repositories a folder holds at its top level. Nested repositories and extra
 * checkouts of one repository are left out, since a thread can't use them side by side.
 */
export function topLevelRepositories(repositories: readonly WorkspaceRepository[]) {
  const kept: WorkspaceRepository[] = [];
  for (const repository of [...repositories].sort((a, b) => a.path.localeCompare(b.path))) {
    if (kept.some((parent) => isInsideFolder(parent.path, repository.path))) continue;
    const twin = kept.findIndex((entry) => entry.commonDir === repository.commonDir);
    if (twin === -1) kept.push(repository);
    else if (isLinkedWorktree(kept[twin]!) && !isLinkedWorktree(repository))
      kept[twin] = repository;
  }
  return kept;
}

export function draftRepositoryFromDefault(entry: WorkspaceRepositoryDefault): DraftRepository {
  return {
    id: entry.path,
    label: basename(entry.path),
    path: entry.path,
    commonDir: entry.commonDir,
    mode: entry.mode,
    branch: null,
    head: "",
  };
}

export const repositoryDefaultFrom = (repository: DraftRepository): WorkspaceRepositoryDefault => ({
  path: repository.path,
  commonDir: repository.commonDir,
  mode: repository.mode,
});

export function draftRepositoryFrom(repository: WorkspaceRepository, id: string): DraftRepository {
  return {
    id,
    label: basename(repository.path),
    path: repository.path,
    commonDir: repository.commonDir,
    mode: isLinkedWorktree(repository) ? "existing-worktree" : "current",
    branch: repository.branch,
    head: repository.head,
  };
}

const randomHex = (length: number) =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const temporaryBranch = (random: (length: number) => string = randomHex) =>
  buildTemporaryWorktreeBranchName(random);

/** The thread's own project, configured by the toolbar's workspace and branch controls. */
export function primaryBindingRequest(input: {
  readonly label: string;
  readonly workspaceRoot: string;
  readonly randomHex?: (length: number) => string;
  readonly envMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly branch: string | null;
}): WorkspaceBindingRequest {
  if (input.worktreePath)
    return {
      id: "primary",
      label: input.label,
      sourcePath: input.worktreePath,
      mode: "existing-worktree",
    };
  if (input.envMode === "worktree" && input.branch)
    return {
      id: "primary",
      label: input.label,
      sourcePath: input.workspaceRoot,
      mode: "new-worktree",
      baseRef: input.branch,
      branch: temporaryBranch(input.randomHex),
    };
  return { id: "primary", label: input.label, sourcePath: input.workspaceRoot, mode: "current" };
}

export function draftBindingRequest(
  repository: DraftRepository,
  random?: (length: number) => string,
): WorkspaceBindingRequest {
  if (repository.mode !== "new-worktree")
    return {
      id: repository.id,
      label: repository.label,
      sourcePath: repository.path,
      mode: repository.mode,
    };
  // Without a known branch the server starts the worktree from the repository's default one.
  const baseRef = repository.branch ?? (repository.head || null);
  return {
    id: repository.id,
    label: repository.label,
    sourcePath: repository.path,
    mode: "new-worktree",
    ...(baseRef ? { baseRef } : {}),
    branch: temporaryBranch(random),
    ...(repository.startFromOrigin !== undefined
      ? { startFromOrigin: repository.startFromOrigin }
      : {}),
  };
}

/**
 * Binding IDs name each new worktree's folder, which the agent reads in every path,
 * so they come from the repository labels: `web`, `api`, `api-2`.
 */
export function workspaceConfiguration(input: {
  /** The project's own checkout; a folder project has none. */
  readonly randomHex?: (length: number) => string;
  readonly primary: WorkspaceBindingRequest | null;
  readonly root?: WorkspaceRootRequest;
  readonly repositories: readonly DraftRepository[];
  readonly expectedRevision: number;
  readonly startFromOrigin?: boolean;
}): WorkspaceConfiguration {
  const { primary, root, expectedRevision } = input;
  const taken = new Set<string>();
  const readableId = (label: string) => {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "repo";
    let id = base;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
    taken.add(id);
    return id;
  };
  // The mirror folder sits beside worktrees named by these IDs, so its name is taken.
  if (root?.mode === "mirror") readableId(basename(root.sourcePath));
  // A folder's mode applies to every repository inside it. A mirror shows no base per
  // repository, so each one starts from its default branch rather than whatever its
  // checkout happens to be on.
  const repositories = input.repositories.map((repository) =>
    root && isInsideFolder(root.sourcePath, repository.path)
      ? root.mode === "mirror"
        ? { ...repository, mode: "new-worktree" as const, branch: null, head: "" }
        : {
            ...repository,
            mode: repository.mode === "existing-worktree" ? repository.mode : ("current" as const),
          }
      : repository,
  );
  const bindings = [
    ...(primary ? [primary] : []),
    ...repositories.map((repository) => draftBindingRequest(repository, input.randomHex)),
  ].map((binding) => ({
    ...binding,
    id: readableId(binding.label),
    ...(binding.mode === "new-worktree"
      ? { startFromOrigin: binding.startFromOrigin ?? input.startFromOrigin ?? true }
      : {}),
  }));
  return {
    expectedRevision,
    ...(root ? { root } : {}),
    primaryBindingId: bindings[0]!.id,
    bindings,
  };
}

/** Thread workspaces keep their bindings; reconfiguring starts from what was recorded. */
export function draftRepositoryFromBinding(binding: WorkspaceBinding): DraftRepository {
  return {
    id: binding.id,
    label: binding.label,
    path: binding.sourcePath,
    commonDir: binding.commonDir,
    mode: binding.mode,
    branch: binding.mode === "new-worktree" ? (binding.baseRef ?? null) : binding.branch,
    head: binding.baseCommit,
    ...(binding.startFromOrigin !== undefined ? { startFromOrigin: binding.startFromOrigin } : {}),
  };
}

export function workspaceProgress(workspace: ThreadWorkspace) {
  return {
    ready: workspace.bindings.filter((binding) => binding.state === "ready").length,
    total: workspace.bindings.length,
    failed: workspace.bindings.filter((binding) => binding.state === "failed"),
  };
}

/** "web", "web + api", or "web + 2". */
export function repositoriesSummary(labels: readonly string[]) {
  const [first, second, ...rest] = labels;
  if (!first) return "";
  if (!second) return first;
  return rest.length === 0 ? `${first} + ${second}` : `${first} + ${rest.length + 1}`;
}
