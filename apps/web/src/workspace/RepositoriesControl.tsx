import {
  CommandId,
  hasRepositorySet,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BookmarkIcon,
  CopyIcon,
  FileDiffIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  FolderTreeIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { ComposerControl, ComposerControlChevron } from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { ComposerContextLabel } from "../components/ComposerContextLabel";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { cn, randomUUID } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShell } from "../state/entities";
import { forkWorkspace } from "../state/forkWorkspace";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRepositoryStatus } from "./ThreadRepositoriesSection";
import { useAddRepository } from "./useAddRepository";
import {
  useComposerRepositories,
  useMultiRepositoryVersion,
  useSaveRepositoryDefault,
} from "./useComposerRepositories";
import {
  CHECKOUT_MODE_LABEL,
  REPOSITORY_LIMIT,
  basename,
  draftBindingRequest,
  draftRepositoryFromBinding,
  isInsideFolder,
  primaryBindingRequest,
  repositoriesSummary,
  repositoryDefaultFrom,
  workspaceConfiguration,
  workspaceProgress,
  type DraftRepository,
} from "./workspaceModel";
import { useWorkspaceUiStore } from "./workspaceStores";

interface RepositoriesControlProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The composer's key: the draft ID before the thread exists, the thread's key after. */
  readonly composerKey: string;
  readonly project: {
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  };
  readonly isGitRepo: boolean;
  readonly envMode: "local" | "worktree";
  readonly startFromOrigin: boolean;
  readonly onEnvModeChange: (mode: "local" | "worktree") => void;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export const FOLDER_MODE_LABEL = { local: "Current folder", worktree: "New worktrees" } as const;

/**
 * The thread's repositories, next to its workspace and branch. Before the first
 * message the user picks them here; afterwards this shows them and their actions.
 * A project folder that holds repositories rather than being one lists them here too.
 */
export const RepositoriesControl = memo(function RepositoriesControl(
  props: RepositoriesControlProps,
) {
  const version = useMultiRepositoryVersion(props.environmentId);
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(threadRef);
  const workspace = shell?.workspace;
  const started = Boolean(
    shell && (shell.latestRun !== null || shell.itemCount > 0 || shell.runtime !== null),
  );
  // Membership only changes before the first message, and not while repositories prepare.
  const editable =
    !started && (!workspace || workspace.state === "failed" || workspace.state === "cancelled");
  const selection = useComposerRepositories({
    composerKey: props.composerKey,
    environmentId: props.environmentId,
    project: props.project,
    isGitRepo: props.isGitRepo,
    workspace,
    choosing: editable,
  });
  const menuProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  if (version < 1) return null;
  const configured = hasRepositorySet(workspace);
  if (!configured && !(editable && (props.isGitRepo || selection.folder))) return null;

  const folder = configured ? workspace!.root !== undefined : selection.folder;
  const labels = configured
    ? workspace!.bindings.map((binding) => binding.label)
    : folder
      ? selection.repositories.map((repository) => repository.label)
      : [props.project.title, ...selection.repositories.map((repository) => repository.label)];
  const progress = workspace ? workspaceProgress(workspace) : null;
  const preparing = workspace && ["planned", "validating", "preparing"].includes(workspace.state);
  const failed = workspace?.state === "failed";
  const summary = folder
    ? `${props.project.title} · ${labels.length} ${labels.length === 1 ? "repository" : "repositories"}`
    : repositoriesSummary(labels);
  const trigger =
    folder || labels.length > 1 ? (
      <>
        {preparing ? (
          <Spinner size="xs" />
        ) : failed ? (
          <TriangleAlertIcon className="size-3 text-destructive" />
        ) : folder ? (
          <FolderTreeIcon className="size-3" />
        ) : (
          <FolderGit2Icon className="size-3" />
        )}
        <ComposerContextLabel>{summary}</ComposerContextLabel>
        <ComposerControlChevron size="xs" />
      </>
    ) : (
      <FolderPlusIcon className="size-3" />
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size="xs"
                  aria-label={folder || labels.length > 1 ? "Repositories" : "Add repositories"}
                  data-composer-context-control
                />
              }
            />
          }
        >
          {trigger}
        </TooltipTrigger>
        <TooltipPopup>
          {preparing && progress
            ? `Preparing ${progress.ready} of ${progress.total} repositories`
            : folder || labels.length > 1
              ? summary
              : "Add repositories to this thread"}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="top" align="start" width="lg" padding="compact" {...menuProps}>
        {editable ? (
          <EditableRepositories
            {...props}
            selection={selection}
            folder={folder}
            onDone={() => setOpen(false)}
          />
        ) : (
          <ThreadRepositories
            detail={
              started ? "Fixed once the thread has started" : "Preparing before the first message"
            }
            environmentId={props.environmentId}
            threadId={props.threadId}
            bindings={workspace!.bindings}
            primaryBindingId={workspace!.primaryBindingId}
            workspaceRevision={workspace!.revision}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
});

function PopoverHeading(props: { title: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1 pt-1 pb-2">
      <span className="font-medium text-sm">{props.title}</span>
      <span className="truncate text-muted-foreground text-xs">{props.detail}</span>
    </div>
  );
}

function EditableRepositories(
  props: RepositoriesControlProps & {
    readonly selection: ReturnType<typeof useComposerRepositories>;
    readonly folder: boolean;
    readonly onDone: () => void;
  },
) {
  const { environmentId, threadId, composerKey, project, selection, folder } = props;
  const workspace = useThreadShell(scopeThreadRef(environmentId, threadId))?.workspace;
  const settings = useEnvironmentSettings(environmentId);
  const openAdd = useAddRepository({
    draftKey: composerKey,
    environmentId,
    projectId: project.id,
    primaryRoot: project.workspaceRoot,
  });
  const saveDefault = useSaveRepositoryDefault(environmentId, project.id);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const { repositories } = selection;
  // Edits apply to the draft's own copy of the list, made on the first change.
  const seed = () => {
    if (selection.untouched)
      useWorkspaceUiStore.getState().setDraftRepositories(composerKey, {
        environmentId,
        projectId: project.id,
        repositories,
      });
  };
  const recordedPrimary = workspace?.bindings.find(
    (binding) => binding.id === workspace.primaryBindingId,
  );
  const primary = folder
    ? null
    : recordedPrimary
      ? draftBindingRequest(draftRepositoryFromBinding(recordedPrimary))
      : primaryBindingRequest({
          label: project.title,
          workspaceRoot: project.workspaceRoot,
          envMode: props.envMode,
          worktreePath: props.worktreePath,
          branch: props.branch,
        });
  const inFolder = (repository: DraftRepository) =>
    folder && isInsideFolder(project.workspaceRoot, repository.path);
  const isDefault =
    selection.saved.length === repositories.length &&
    repositories.every((repository, index) => {
      const saved = selection.saved[index]!;
      const next = repositoryDefaultFrom(repository);
      return saved.path === next.path && saved.mode === next.mode;
    });

  // Before the first message the selection is prepared on Send. A thread that already
  // exists, because an earlier preparation failed, prepares again from here.
  const prepareAgain = async () => {
    if (!workspace) return;
    setSaving(true);
    const result = await dispatch({
      environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(randomUUID()),
        threadId,
        workspaceConfiguration: workspaceConfiguration({
          primary,
          ...(folder
            ? {
                root: {
                  sourcePath: project.workspaceRoot,
                  mode: props.envMode === "worktree" ? "mirror" : "current",
                },
              }
            : {}),
          repositories,
          expectedRevision: workspace.revision,
          startFromOrigin:
            props.envMode === "worktree"
              ? props.startFromOrigin
              : resolveProjectSettings(settings, project.id).settings.newWorktreesStartFromOrigin,
        }),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Couldn't prepare the repositories",
        description: String(squashAtomCommandFailure(result)),
      });
      return;
    }
    useWorkspaceUiStore.getState().setDraftRepositories(composerKey, null);
    props.onDone();
  };

  return (
    <div className="flex flex-col">
      <PopoverHeading title="Repositories" detail="The agent works across all of them" />
      <ul className="flex flex-col gap-0.5">
        {folder ? (
          <RepositoryRow
            icon={<FolderTreeIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            label={project.title}
            detail={project.workspaceRoot}
            trailing={
              <Select
                value={props.envMode}
                onValueChange={(mode) =>
                  props.onEnvModeChange(mode === "worktree" ? "worktree" : "local")
                }
              >
                <SelectTrigger size="xs" aria-label={`Checkout for ${project.title}`}>
                  <SelectValue>{FOLDER_MODE_LABEL[props.envMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="local">{FOLDER_MODE_LABEL.local}</SelectItem>
                  <SelectItem value="worktree">{FOLDER_MODE_LABEL.worktree}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        ) : (
          <RepositoryRow
            label={recordedPrimary?.label ?? project.title}
            detail={primary!.sourcePath}
            trailing={
              <span className="shrink-0 text-muted-foreground text-xs">
                {CHECKOUT_MODE_LABEL[primary!.mode]}
              </span>
            }
          />
        )}
        {repositories.map((repository) => (
          <RepositoryRow
            key={repository.id}
            label={repository.label}
            detail={
              inFolder(repository)
                ? repository.path.slice(project.workspaceRoot.replace(/[\\/]+$/, "").length + 1)
                : repository.path
            }
            nested={inFolder(repository)}
            trailing={
              <>
                {inFolder(repository) ? null : repository.mode === "existing-worktree" ? (
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {CHECKOUT_MODE_LABEL["existing-worktree"]}
                  </span>
                ) : (
                  <Select
                    value={repository.mode}
                    onValueChange={(mode) => {
                      seed();
                      useWorkspaceUiStore
                        .getState()
                        .setDraftRepositoryMode(
                          composerKey,
                          repository.id,
                          mode === "new-worktree" ? "new-worktree" : "current",
                        );
                    }}
                  >
                    <SelectTrigger size="xs" aria-label={`Checkout for ${repository.label}`}>
                      <SelectValue>{CHECKOUT_MODE_LABEL[repository.mode]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="current">{CHECKOUT_MODE_LABEL.current}</SelectItem>
                      <SelectItem value="new-worktree">
                        {CHECKOUT_MODE_LABEL["new-worktree"]}
                        {repository.branch ? ` from ${repository.branch}` : ""}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Remove ${repository.label}`}
                  onClick={() => {
                    seed();
                    useWorkspaceUiStore
                      .getState()
                      .removeDraftRepository(composerKey, repository.id);
                  }}
                >
                  <XIcon />
                </Button>
              </>
            }
          />
        ))}
      </ul>
      {selection.untouched &&
      selection.saved.length === 0 &&
      selection.foundCount > REPOSITORY_LIMIT ? (
        <p className="px-1 pt-1 text-muted-foreground text-xs">
          Showing the first {REPOSITORY_LIMIT} of {selection.foundCount} repositories in this
          folder.
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          // The project's own checkout takes one of the thread's places unless it's a folder.
          disabled={repositories.length >= REPOSITORY_LIMIT - (folder ? 0 : 1)}
          onClick={() => {
            seed();
            props.onDone();
            openAdd();
          }}
        >
          <PlusIcon />
          Add repository
        </Button>
        {isDefault ? null : (
          <Button size="sm" variant="ghost" onClick={() => void saveDefault(repositories)}>
            <BookmarkIcon />
            Save as project default
          </Button>
        )}
        {selection.saved.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => void saveDefault(null)}>
            Clear project default
          </Button>
        ) : null}
      </div>
      <p className="mt-2 border-t px-1 pt-2 text-muted-foreground text-xs">
        {folder && props.envMode === "worktree"
          ? `Each repository gets a new worktree from its default branch at its place in a copy of ${basename(project.workspaceRoot)}. Files outside the repositories aren't copied.`
          : workspace
            ? "Each repository keeps its own branch. New worktrees start from the latest commit."
            : "Prepared when you send. New worktrees start from the latest commit; uncommitted changes stay where they are."}
      </p>
      {workspace ? (
        <Button
          size="sm"
          className="mt-2"
          disabled={saving || repositories.length === 0}
          onClick={() => void prepareAgain()}
        >
          {saving ? "Preparing…" : "Prepare repositories"}
        </Button>
      ) : null}
    </div>
  );
}

function RepositoryRow(props: {
  label: string;
  detail: string;
  icon?: ReactNode;
  /** Indented under the folder it lives in. */
  nested?: boolean;
  status?: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <li className={cn("flex min-h-8 items-center gap-2 rounded-md px-1", props.nested && "ps-4")}>
      {props.icon ?? <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 truncate text-sm">
          {props.label}
          {props.status}
        </span>
        <span className="truncate text-muted-foreground text-xs">{props.detail}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">{props.trailing}</div>
    </li>
  );
}

const STATE_LABEL: Partial<Record<WorkspaceBinding["state"], string>> = {
  planned: "Waiting",
  validating: "Checking",
  preparing: "Preparing",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A started thread's repositories with what can be done in each. */
export function ThreadRepositories(props: {
  detail: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  bindings: readonly WorkspaceBinding[];
  primaryBindingId: string;
  workspaceRevision: number;
}) {
  const actions = useRepositoryActions(
    props.environmentId,
    props.threadId,
    props.workspaceRevision,
  );
  return (
    <div className="flex flex-col">
      <PopoverHeading title="Repositories" detail={props.detail} />
      <ul className="flex flex-col gap-0.5">
        {props.bindings.map((binding) => (
          <ThreadRepositoryRow
            key={binding.id}
            environmentId={props.environmentId}
            binding={binding}
            status={
              STATE_LABEL[binding.state] ? (
                <Badge variant={binding.state === "failed" ? "error" : "secondary"}>
                  {STATE_LABEL[binding.state]}
                </Badge>
              ) : null
            }
            trailing={
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Actions for ${binding.label}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={binding.state !== "ready"}
                    onClick={() => actions.showChanges(binding)}
                  >
                    <FileDiffIcon />
                    Show changes
                  </MenuItem>
                  <MenuItem
                    disabled={binding.state !== "ready"}
                    onClick={() => void actions.openTerminal(binding)}
                  >
                    <SquareTerminalIcon />
                    Open terminal here
                  </MenuItem>
                  <MenuItem onClick={() => void actions.copyPath(binding)}>
                    <CopyIcon />
                    Copy path
                  </MenuItem>
                </MenuPopup>
              </Menu>
            }
          />
        ))}
      </ul>
    </div>
  );
}

function ThreadRepositoryRow(props: {
  environmentId: EnvironmentId;
  binding: WorkspaceBinding;
  status: ReactNode;
  trailing: ReactNode;
}) {
  const live = useRepositoryStatus(props.environmentId, props.binding);
  return (
    <RepositoryRow
      label={props.binding.label}
      detail={`${live.branch ?? "detached HEAD"} · ${CHECKOUT_MODE_LABEL[props.binding.mode]}${live.dirty ? " · uncommitted changes" : ""}`}
      status={props.status}
      trailing={props.trailing}
    />
  );
}

/** What a repository row can do. Each action names its repository; none falls back to another. */
export function useRepositoryActions(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  workspaceRevision: number,
) {
  const openTerminal = useAtomCommand(forkWorkspace.terminal, { reportFailure: false });
  const threadRef = scopeThreadRef(environmentId, threadId);
  const threadKey = scopedThreadKey(threadRef);
  return {
    showChanges: (binding: WorkspaceBinding) => {
      useWorkspaceUiStore.getState().setActiveRepository(threadKey, binding.id);
      useRightPanelStore.getState().open(threadRef, "diff");
    },
    openTerminal: async (binding: WorkspaceBinding) => {
      // The server resolves `repo:<binding>` terminal IDs to that checkout.
      const terminalId = `repo:${binding.id}:${randomUUID().slice(0, 8)}`;
      const result = await openTerminal({
        environmentId,
        input: { threadId, bindingId: binding.id, expectedRevision: workspaceRevision, terminalId },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: `Couldn't open a terminal in ${binding.label}`,
          description: String(squashAtomCommandFailure(result)),
        });
        return;
      }
      useTerminalUiStateStore
        .getState()
        .ensureTerminal(threadRef, terminalId, { open: true, active: true });
    },
    copyPath: async (binding: WorkspaceBinding) => {
      if (await writeTextToClipboard(binding.checkoutPath, "repository path"))
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: binding.checkoutPath,
        });
    },
  };
}
