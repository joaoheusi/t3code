import {
  hasRepositorySet,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadPullRequestLink,
  type ThreadWorkspace,
  type WorkspaceBinding,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import {
  CopyIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { DiffStatLabel, hasNonZeroStat } from "../components/chat/DiffStatLabel";
import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsPrRows } from "../components/chat/ThreadDetailsPrRows";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
} from "../components/ThreadStatusIndicators";
import {
  findProjectOnChangeRequestHost,
  parseChangeRequestUrl,
  useOpenPrLink,
} from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { useProjects, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { useRepositoryActions } from "./RepositoriesControl";
import { CHECKOUT_MODE_LABEL } from "./workspaceModel";
import { useWorkspaceUiStore } from "./workspaceStores";

/**
 * The checkout's live state. Its branch can move after preparation, so the recorded one is a
 * fallback. `changes` matches the diff panel's Changes view; older servers report uncommitted
 * totals only.
 */
export function useRepositoryStatus(environmentId: EnvironmentId, binding: WorkspaceBinding) {
  const status = useEnvironmentQuery(
    binding.state === "ready"
      ? vcsEnvironment.status({ environmentId, input: { cwd: binding.checkoutPath } })
      : null,
  );
  const changes = status.data?.branchChanges ?? status.data?.workingTree;
  return {
    branch: status.data?.refName ?? binding.branch,
    dirty: status.data?.hasWorkingTreeChanges ?? false,
    changes: changes ? { additions: changes.insertions, deletions: changes.deletions } : null,
    pr: status.data?.pr ?? null,
    sourceControlProvider: status.data?.sourceControlProvider,
    refresh: status.refresh,
  };
}

type RepositoryStatus = ReturnType<typeof useRepositoryStatus>;

/**
 * A pull request link belongs to the repository it was created or found in. Links made before
 * the thread knew which (by hand, or by the agent) count toward the primary repository.
 */
function repositoryLinks(
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
  workspace: ThreadWorkspace,
  bindingId: string,
) {
  return (links ?? []).filter(
    (link) => (link.bindingId ?? workspace.primaryBindingId) === bindingId,
  );
}

/** The repository's pull request: its current link, else the one on its checked-out branch. */
function useRepositoryPullRequest(
  threadRef: ScopedThreadRef,
  binding: WorkspaceBinding,
  status: RepositoryStatus,
) {
  const thread = useThreadShell(threadRef);
  const links = thread?.workspace
    ? repositoryLinks(thread.pullRequests, thread.workspace, binding.id)
    : [];
  const current = resolveThreadCurrentPullRequestLink(links);
  const linked = current === null ? null : linkedPullRequestSnapshotStatus(current);
  const pr = linked?.pr ?? (current === null ? status.pr : null);
  return {
    links,
    current,
    pr,
    number: current?.number ?? pr?.number,
    url: current?.url ?? pr?.url,
    indicator: prStatusIndicator(pr, linked?.sourceControlProvider ?? status.sourceControlProvider),
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
            threadRef={props.threadRef}
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
  threadRef: ScopedThreadRef;
  binding: WorkspaceBinding;
  active: boolean;
  actions: ReturnType<typeof useRepositoryActions>;
  onSelect: () => void;
}) {
  const { binding, actions } = props;
  const ready = binding.state === "ready";
  const status = useRepositoryStatus(props.environmentId, binding);
  const pullRequest = useRepositoryPullRequest(props.threadRef, binding, status);
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
          {status.changes && hasNonZeroStat(status.changes) ? (
            <DiffStatLabel
              additions={status.changes.additions}
              deletions={status.changes.deletions}
              layout="inline"
              className="shrink-0 font-normal text-2xs"
            />
          ) : null}
          {status.dirty ? (
            <span
              aria-label="Uncommitted changes"
              className="size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : null}
          {pullRequest.indicator ? (
            <pullRequest.indicator.Icon
              aria-label={`${pullRequest.indicator.label} #${pullRequest.number}`}
              className={cn("size-3 shrink-0", pullRequest.indicator.colorClass)}
            />
          ) : null}
          <span className="ms-auto min-w-0 truncate font-normal text-muted-foreground text-xs">
            {ready ? (status.branch ?? "detached HEAD") : binding.state}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          {binding.checkoutPath} · {CHECKOUT_MODE_LABEL[binding.mode]}
          {status.dirty ? " · Uncommitted changes" : ""}
          {pullRequest.indicator ? ` · ${pullRequest.indicator.tooltip}` : ""}
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

/** A repository's branch. Its checkout was fixed when the thread's repositories were prepared. */
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

/** The repository's pull requests, as the single-repository branch row shows the thread's. */
export function RepositoryPullRequestRows(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  binding: WorkspaceBinding;
}) {
  const status = useRepositoryStatus(props.environmentId, props.binding);
  const { links, current, pr, number, url, indicator } = useRepositoryPullRequest(
    props.threadRef,
    props.binding,
    status,
  );
  const projects = useProjects();
  const openPrLink = useOpenPrLink(props.threadRef);
  if (number === undefined || url === undefined) return null;
  const parsed = parseChangeRequestUrl(url);
  // Read through any project on the pull request's host: a folder thread's own project has none.
  const project =
    parsed === null
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === props.environmentId),
          parsed,
        ) ?? null);
  return (
    <ThreadDetailsPrRows
      threadRef={props.threadRef}
      links={links}
      currentLink={current}
      onOpenLink={openPrLink}
      environmentId={props.environmentId}
      pr={pr}
      number={number}
      reference={current ?? (parsed === null ? null : { ...parsed, number })}
      status={indicator}
      project={project}
      label={`#${number}${pr?.title.trim() ? `: ${pr.title}` : ""}`}
      openAriaLabel={url}
      onOpen={(event) => openPrLink(event, url)}
      onActed={status.refresh}
    />
  );
}
