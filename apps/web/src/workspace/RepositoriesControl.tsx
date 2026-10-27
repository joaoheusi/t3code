import { useAtomValue } from "@effect/atom-react";
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
  ArrowLeftIcon,
  CopyIcon,
  FileDiffIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { ComposerControl, ComposerControlChevron } from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { ComposerContextLabel } from "../components/ComposerContextLabel";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Command, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Spinner } from "../components/ui/spinner";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { cn, randomUUID } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShell } from "../state/entities";
import { forkWorkspace } from "../state/forkWorkspace";
import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { WorktreeBaseBranchPicker } from "../components/WorktreeBaseBranchPicker";
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
  workspaceConfiguration,
  workspaceProgress,
  WORKSPACE_STATE_LABEL,
  type DraftRepository,
} from "./workspaceModel";
import { useWorkspaceUiStore } from "./workspaceStores";

interface RepositoriesProps {
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
}

/**
 * The repositories a thread works in: chosen before the first message, fixed after.
 * The toolbar reads this too, since a thread with several repositories picks each
 * one's base branch in the repositories popover instead of the toolbar.
 */
export function useThreadRepositories(
  props: Omit<RepositoriesProps, "project"> & {
    readonly project: RepositoriesProps["project"] | null;
  },
) {
  const version = useMultiRepositoryVersion(props.environmentId);
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
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
  const configured = hasRepositorySet(workspace);
  const loading = selection.loading && !configured;
  const visible =
    props.project !== null &&
    (configured ||
      (editable && (loading || (version >= 1 && (props.isGitRepo || selection.folder)))));
  const folder = configured ? workspace!.root !== undefined : selection.folder;
  const labels = configured
    ? workspace!.bindings.map((binding) => binding.label)
    : folder
      ? selection.repositories.map((repository) => repository.label)
      : [
          props.project?.title ?? "",
          ...selection.repositories.map((repository) => repository.label),
        ];
  return {
    workspace,
    started,
    editable,
    selection,
    visible,
    /** Still finding the repositories, so the control renders disabled instead of late. */
    loading,
    folder,
    labels,
    /** More than the project's own checkout, so the popover owns every repository's base. */
    multiple: visible && !loading && (folder || labels.length > 1),
  };
}

export interface RepositoriesControlHandle {
  open: () => void;
}

interface RepositoriesControlProps extends RepositoriesProps {
  readonly ref?: Ref<RepositoriesControlHandle>;
  readonly repositories: ReturnType<typeof useThreadRepositories>;
  readonly envMode: "local" | "worktree";
  readonly envModeLocked: boolean;
  readonly startFromOrigin: boolean;
  readonly onEnvModeChange: (mode: "local" | "worktree") => void;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  /** The project checkout's own branch control, shown on its row. */
  readonly primaryBranch: ReactNode;
}

/**
 * The thread's repositories, next to its workspace and branch. Before the first
 * message the user picks them here; afterwards this shows them and their actions.
 * A project folder that holds repositories rather than being one lists them here too.
 */
export const RepositoriesControl = memo(function RepositoriesControl({
  ref,
  ...props
}: RepositoriesControlProps) {
  const { workspace, started, editable, visible, loading, folder, labels, multiple } =
    props.repositories;
  const menuProps = useComposerMenuProps();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [open, setOpen] = useState(false);
  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (!loading) setOpen(true);
      },
    }),
    [loading],
  );
  if (!visible) return null;

  // The strip keeps its place while repositories are found; the control wakes up in place.
  if (loading) {
    return (
      <ComposerControl
        size="xs"
        disabled
        aria-label="Finding repositories"
        data-composer-context-control
      >
        <Spinner size="xs" />
        <ComposerContextLabel>Finding repositories…</ComposerContextLabel>
      </ComposerControl>
    );
  }

  const progress = workspace ? workspaceProgress(workspace) : null;
  const preparing = workspace && ["planned", "validating", "preparing"].includes(workspace.state);
  const failed = workspace?.state === "failed";
  const summary = folder
    ? `${props.project.title} · ${labels.length} ${labels.length === 1 ? "repository" : "repositories"}`
    : repositoriesSummary(labels);
  const trigger = multiple ? (
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

  const shortcutLabel = shortcutLabelForCommand(keybindings, "composer.repositories");
  const tooltipLabel =
    preparing && progress
      ? `Preparing ${progress.ready} of ${progress.total} repositories`
      : multiple
        ? summary
        : "Add repositories to this thread";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size="xs"
                  aria-label={multiple ? summary : "Add repositories"}
                  data-composer-shortcut="composer.repositories"
                  data-composer-context-control
                />
              }
            />
          }
        >
          {trigger}
        </TooltipTrigger>
        <TooltipPopup>
          {shortcutLabel ? `${tooltipLabel} · ${shortcutLabel}` : tooltipLabel}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="top"
        align="start"
        width="lg"
        padding="compact"
        aria-label="Repositories"
        {...menuProps}
      >
        {editable ? (
          <EditableRepositories {...props} onDone={() => setOpen(false)} />
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
    <div className="flex items-baseline justify-between gap-3 px-2 pt-1 pb-2">
      <span className="font-medium text-sm">{props.title}</span>
      <span className="truncate text-muted-foreground text-xs">{props.detail}</span>
    </div>
  );
}

function EditableRepositories(props: RepositoriesControlProps & { readonly onDone: () => void }) {
  const { environmentId, threadId, composerKey, project, envMode } = props;
  const { selection, folder } = props.repositories;
  const workspace = useThreadShell(scopeThreadRef(environmentId, threadId))?.workspace;
  const settings = useEnvironmentSettings(environmentId);
  const add = useAddRepository({
    draftKey: composerKey,
    environmentId,
    projectId: project.id,
    primaryRoot: project.workspaceRoot,
    envMode,
  });
  const saveDefault = useSaveRepositoryDefault(environmentId, project.id);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusAddButtonOnReturnRef = useRef(false);
  const { repositories } = selection;
  // Leaving the picker unmounts its search field; land back on the button that opened it.
  useEffect(() => {
    if (adding || !focusAddButtonOnReturnRef.current) return;
    focusAddButtonOnReturnRef.current = false;
    const addButton = addButtonRef.current;
    if (addButton && !addButton.disabled) {
      addButton.focus({ preventScroll: true });
      return;
    }
    // Adding the final allowed repository disables that button. Land on the last
    // repository's Remove button instead of dropping focus to the body.
    const removeButtons = listRef.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-remove-repository]:not(:disabled)",
    );
    removeButtons?.[removeButtons.length - 1]?.focus({ preventScroll: true });
  }, [adding]);
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
          envMode,
          worktreePath: props.worktreePath,
          branch: props.branch,
        });
  // Added repositories start new worktrees the way the thread's own checkout would.
  const threadStartsFromOrigin =
    envMode === "worktree"
      ? props.startFromOrigin
      : resolveProjectSettings(settings, project.id).settings.newWorktreesStartFromOrigin;
  const inFolder = (repository: DraftRepository) =>
    folder && isInsideFolder(project.workspaceRoot, repository.path);
  // Every repository follows the thread's mode, so a default is just which ones.
  const isDefault =
    selection.saved.length > 0 &&
    selection.saved.length === repositories.length &&
    repositories.every((repository, index) => selection.saved[index]!.path === repository.path);

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
                  mode: envMode === "worktree" ? "mirror" : "current",
                },
              }
            : {}),
          repositories,
          envMode,
          expectedRevision: workspace.revision,
          startFromOrigin: threadStartsFromOrigin,
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

  if (adding)
    return (
      <AddRepositoryPicker
        projects={add.projects.filter(
          (candidate) =>
            !repositories.some((repository) => repository.path === candidate.workspaceRoot),
        )}
        onPick={async (path) => {
          seed();
          await add.addPath(path);
          focusAddButtonOnReturnRef.current = true;
          setAdding(false);
        }}
        onBrowse={() => {
          seed();
          props.onDone();
          add.browse();
        }}
        onBack={() => {
          focusAddButtonOnReturnRef.current = true;
          setAdding(false);
        }}
      />
    );

  return (
    <div className="flex flex-col">
      <ToggleGroup
        aria-label="How repositories are checked out"
        className="mb-2 w-full *:flex-1"
        disabled={props.envModeLocked}
        value={[envMode]}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "local" || mode === "worktree") props.onEnvModeChange(mode);
        }}
      >
        <Toggle value="worktree">New worktrees</Toggle>
        <Toggle value="local">{folder ? "Current folder" : "Current checkouts"}</Toggle>
      </ToggleGroup>
      <ul ref={listRef} className="flex flex-col gap-0.5" aria-label="Repositories in this thread">
        {folder ? (
          <RepositoryRow
            icon={<FolderTreeIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            label={project.title}
            path={project.workspaceRoot}
          />
        ) : (
          <RepositoryRow
            label={recordedPrimary?.label ?? project.title}
            path={primary!.sourcePath}
            trailing={props.primaryBranch}
          />
        )}
        {repositories.map((repository) => (
          <RepositoryRow
            key={repository.id}
            label={repository.label}
            path={repository.path}
            nested={inFolder(repository)}
            trailing={
              <>
                {inFolder(repository) ? (
                  envMode === "worktree" ? (
                    <BranchLabel>Default branch</BranchLabel>
                  ) : (
                    <CheckoutBranchLabel
                      environmentId={environmentId}
                      path={repository.path}
                      branch={repository.branch}
                    />
                  )
                ) : repository.mode === "existing-worktree" ? (
                  <BranchLabel>{CHECKOUT_MODE_LABEL["existing-worktree"]}</BranchLabel>
                ) : envMode === "worktree" ? (
                  <WorktreeBaseBranchPicker
                    compact
                    // A repository from the project's default has no base until one is picked.
                    placeholder="Default branch"
                    environmentId={environmentId}
                    cwd={repository.path}
                    value={repository.branch ?? ""}
                    onValueChange={(branch) => {
                      seed();
                      useWorkspaceUiStore
                        .getState()
                        .updateDraftRepository(composerKey, repository.id, { branch });
                    }}
                    startFromOrigin={repository.startFromOrigin ?? threadStartsFromOrigin}
                    onStartFromOriginChange={(startFromOrigin) => {
                      seed();
                      useWorkspaceUiStore
                        .getState()
                        .updateDraftRepository(composerKey, repository.id, { startFromOrigin });
                    }}
                  />
                ) : (
                  <CheckoutBranchLabel
                    environmentId={environmentId}
                    path={repository.path}
                    branch={repository.branch}
                  />
                )}
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  // The chevron and X glyphs carry their own whitespace; this evens the visible gap.
                  className="-ms-0.75"
                  data-remove-repository
                  aria-label={`Remove ${repository.label}`}
                  onClick={() => {
                    seed();
                    useWorkspaceUiStore
                      .getState()
                      .removeDraftRepository(composerKey, repository.id);
                    // This button unmounts with its row; land on Add instead of the body.
                    // Deferred because removing can be what re-enables that button.
                    requestAnimationFrame(() =>
                      addButtonRef.current?.focus({ preventScroll: true }),
                    );
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
        <p className="px-2 pt-1 text-muted-foreground text-xs">
          Showing the first {REPOSITORY_LIMIT} of {selection.foundCount} repositories in this
          folder.
        </p>
      ) : null}
      <button
        ref={addButtonRef}
        type="button"
        className="mt-0.5 flex min-h-8 items-center gap-2 rounded-md ps-2 pe-1 text-muted-foreground text-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        // The project's own checkout takes one of the thread's places unless it's a folder.
        disabled={repositories.length >= REPOSITORY_LIMIT - (folder ? 0 : 1)}
        onClick={() => setAdding(true)}
      >
        <PlusIcon className="size-3.5 shrink-0" />
        Add a repository
      </button>
      {folder && envMode === "worktree" ? (
        <p className="px-2 pt-1 text-muted-foreground text-xs">
          Files outside the repositories aren't copied into the new{" "}
          {basename(project.workspaceRoot)} folder.
        </p>
      ) : null}
      {repositories.length > 0 ? (
        <label className="mt-2 flex cursor-pointer items-center gap-2 border-t ps-1.75 pe-1 pt-2 text-xs">
          <Checkbox
            checked={isDefault}
            onCheckedChange={(checked) => void saveDefault(checked ? repositories : null)}
          />
          Use for new threads in this project
        </label>
      ) : null}
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

/** Projects on this machine to add, then any folder. */
function AddRepositoryPicker(props: {
  readonly projects: ReturnType<typeof useAddRepository>["projects"];
  readonly onPick: (path: string) => Promise<void>;
  readonly onBrowse: () => void;
  readonly onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const search = query.trim().toLocaleLowerCase();
  const candidates = props.projects.filter((project) =>
    `${project.title} ${project.workspaceRoot}`.toLocaleLowerCase().includes(search),
  );
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 pb-1">
        <Button size="icon-xs" variant="ghost-muted" aria-label="Back" onClick={props.onBack}>
          <ArrowLeftIcon />
        </Button>
        <span className="font-medium text-sm">Add a repository</span>
      </div>
      <Command mode="none" value={query} onValueChange={setQuery} aria-label="Add a repository">
        <CommandInput placeholder="Search projects…" disabled={pending} />
        <CommandList className="max-h-64 overflow-y-auto">
          {candidates.map((project) => (
            <CommandItem
              key={project.id}
              value={project.id}
              disabled={pending}
              onClick={() => {
                setPending(true);
                void props.onPick(project.workspaceRoot).finally(() => setPending(false));
              }}
            >
              <ProjectFavicon project={project} className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{project.title}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {project.workspaceRoot}
                </span>
              </span>
            </CommandItem>
          ))}
          <CommandItem value="browse" disabled={pending} onClick={props.onBrowse}>
            <FolderOpenIcon aria-hidden className="size-4 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>Browse for a folder…</span>
              <span className="truncate text-muted-foreground text-xs">
                A repository, or a folder that contains repositories
              </span>
            </span>
          </CommandItem>
        </CommandList>
      </Command>
    </div>
  );
}

/** The branch a current checkout is on, read live when the repository came from a default. */
function CheckoutBranchLabel(props: {
  environmentId: EnvironmentId;
  path: string;
  branch: string | null;
}) {
  const status = useEnvironmentQuery(
    props.branch === null
      ? vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.path } })
      : null,
  );
  return (
    <BranchLabel>
      {props.branch ?? (status.data ? (status.data.refName ?? "Detached HEAD") : "…")}
    </BranchLabel>
  );
}

function BranchLabel(props: { children: ReactNode }) {
  return (
    <span className="flex h-6 min-w-0 items-center gap-1.5 ps-1.75 pe-1.5 text-muted-foreground/70 text-xs">
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="truncate">{props.children}</span>
    </span>
  );
}

function RepositoryRow(props: {
  label: string;
  /** Shown on hover; rows stay one line. */
  path?: string;
  detail?: string;
  icon?: ReactNode;
  /** Indented under the folder it lives in. */
  nested?: boolean;
  status?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li className={cn("flex min-h-8 items-center gap-2 ps-2 pe-1", props.nested && "ps-6")}>
      {props.icon ?? <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          {props.path ? (
            <Tooltip>
              {/* Focusable so keyboard users can reach the path hover shows. */}
              <TooltipTrigger
                render={
                  <span
                    className="truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    tabIndex={0}
                    aria-label={`${props.label}: ${props.path}`}
                  />
                }
              >
                {props.label}
              </TooltipTrigger>
              <TooltipPopup>{props.path}</TooltipPopup>
            </Tooltip>
          ) : (
            <span className="truncate">{props.label}</span>
          )}
          {props.status}
        </span>
        {props.detail ? (
          <span className="truncate text-muted-foreground text-xs">{props.detail}</span>
        ) : null}
      </div>
      {/* Branch controls keep 6px between icon, name, and chevron, like the read-only labels. */}
      {props.trailing ? (
        <div className="flex min-w-0 max-w-[60%] items-center justify-end **:data-[slot=combobox-trigger]:gap-1.5 [&_[data-slot=combobox-trigger]>svg:first-child]:me-0">
          {props.trailing}
        </div>
      ) : null}
    </li>
  );
}

/** A started thread's repositories with what can be done in each. */
function ThreadRepositories(props: {
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
              WORKSPACE_STATE_LABEL[binding.state] ? (
                <Badge variant={binding.state === "failed" ? "error" : "secondary"}>
                  {WORKSPACE_STATE_LABEL[binding.state]}
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
                    disabled={binding.state !== "ready" || !actions.canOpenTerminal}
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
  const canOpenTerminal = useAtomValue(forkWorkspace.terminal.permissionAtom(environmentId));
  const openTerminal = useAtomCommand(forkWorkspace.terminal, { reportFailure: false });
  const threadRef = scopeThreadRef(environmentId, threadId);
  const threadKey = scopedThreadKey(threadRef);
  return {
    canOpenTerminal,
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
