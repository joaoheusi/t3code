import {
  hasRepositorySet,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  CopyIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { useRepositoryActions } from "./RepositoriesControl";
import { CHECKOUT_MODE_LABEL } from "./workspaceModel";
import { useWorkspaceUiStore } from "./workspaceStores";

/** The checkout's current branch: it can move after preparation, so the recorded one is a fallback. */
export function useRepositoryStatus(environmentId: EnvironmentId, binding: WorkspaceBinding) {
  const status = useEnvironmentQuery(
    binding.state === "ready"
      ? vcsEnvironment.status({ environmentId, input: { cwd: binding.checkoutPath } })
      : null,
  );
  return {
    branch: status.data?.refName ?? binding.branch,
    dirty: status.data?.hasWorkingTreeChanges ?? false,
  };
}

/**
 * The repository the diff, files, and Git controls show for a thread with several
 * repositories or a folder: the one the user picked, else the thread's primary one.
 */
export function useActiveRepository(threadRef: ScopedThreadRef | null): WorkspaceBinding | null {
  const workspace = useThreadShell(threadRef)?.workspace;
  const picked = useWorkspaceUiStore((state) =>
    threadRef ? state.activeRepository[scopedThreadKey(threadRef)] : undefined,
  );
  if (!hasRepositorySet(workspace)) return null;
  return (
    workspace.bindings.find((binding) => binding.id === picked) ??
    workspace.bindings.find((binding) => binding.id === workspace.primaryBindingId) ??
    null
  );
}

export function ThreadRepositoriesSection(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadRef: ScopedThreadRef;
}) {
  const workspace = useThreadShell(props.threadRef)?.workspace;
  const active = useActiveRepository(props.threadRef);
  const actions = useRepositoryActions(
    props.environmentId,
    props.threadId,
    workspace?.revision ?? 0,
  );
  if (!hasRepositorySet(workspace) || !active) return null;
  const select = (binding: WorkspaceBinding) =>
    useWorkspaceUiStore
      .getState()
      .setActiveRepository(scopedThreadKey(props.threadRef), binding.id);
  return (
    <ThreadDetailsSection headingId="thread-details-repositories-heading" title="Repositories">
      <div className="flex flex-col gap-0.5">
        {workspace.bindings.map((binding) => (
          <RepositorySectionRow
            key={binding.id}
            environmentId={props.environmentId}
            binding={binding}
            active={binding.id === active.id}
            actions={actions}
            onSelect={() => select(binding)}
          />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function RepositorySectionRow(props: {
  environmentId: EnvironmentId;
  binding: WorkspaceBinding;
  active: boolean;
  actions: ReturnType<typeof useRepositoryActions>;
  onSelect: () => void;
}) {
  const { binding, actions } = props;
  const ready = binding.state === "ready";
  const status = useRepositoryStatus(props.environmentId, binding);
  return (
    <div key={binding.id} className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              part="link-primary"
              aria-current={props.active || undefined}
              data-pressed={props.active ? "" : undefined}
              onClick={props.onSelect}
            />
          }
        >
          {ready ? (
            <FolderGit2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          ) : (
            <Spinner size="md" tone="muted" />
          )}
          <span className="min-w-0 truncate">{binding.label}</span>
          {status.dirty ? (
            <span
              aria-label="Uncommitted changes"
              className="size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : null}
          <span className="ms-auto min-w-0 truncate font-normal text-muted-foreground text-xs">
            {ready ? (status.branch ?? "detached HEAD") : binding.state}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          {binding.checkoutPath} · {CHECKOUT_MODE_LABEL[binding.mode]}
          {status.dirty ? " · Uncommitted changes" : ""}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              aria-label={`Actions for ${binding.label}`}
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={!ready} onClick={() => actions.showChanges(binding)}>
            <FileDiffIcon />
            Show changes
          </MenuItem>
          <MenuItem disabled={!ready} onClick={() => void actions.openTerminal(binding)}>
            <SquareTerminalIcon />
            Open terminal here
          </MenuItem>
          <MenuItem onClick={() => void actions.copyPath(binding)}>
            <CopyIcon />
            Copy path
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** A non-primary repository's branch. Its checkout was fixed when the thread's repositories were prepared. */
export function RepositoryBranchRow(props: {
  environmentId: EnvironmentId;
  binding: WorkspaceBinding;
}) {
  const status = useRepositoryStatus(props.environmentId, props.binding);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)} />}
      >
        <GitBranchIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 truncate">{status.branch ?? "detached HEAD"}</span>
        <span className="ms-auto shrink-0 font-normal text-3xs text-muted-foreground/70">
          {props.binding.label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left">{props.binding.checkoutPath}</TooltipPopup>
    </Tooltip>
  );
}
