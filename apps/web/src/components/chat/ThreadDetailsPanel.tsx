import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  RepositoryBranchRow,
  RepositoryPullRequestRows,
  RepositoryWithActivity,
  ThreadRepositoriesSection,
  useActiveRepository,
  useRepositoryBindings,
} from "../../workspace/ThreadRepositoriesSection";
import { useWorkspaceUiStore } from "../../workspace/workspaceStores";

const GitActionsControl = memo(BaseGitActionsControl);

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  branch?: string | null;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  // A multi-repository thread lists its repositories, and each one gets its own version
  // control block below. The picked repository still drives Open in and the diff panel.
  const activeRepository = useActiveRepository(props.draftId ? null : threadRef);
  const repositoryBindings = useRepositoryBindings(props.draftId ? null : threadRef);
  const gitCwd = activeRepository?.checkoutPath ?? props.gitCwd;
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    branch: props.branch ?? null,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
    >
      {(density) => (
        <>
          <ThreadDetailsSection
            headingId="thread-details-workspace-heading"
            title="Workspace"
            separated={false}
            showHeading={false}
          >
            <div className="flex flex-col">
              {density === "full" && !activeRepository ? (
                <BranchToolbar
                  layout="panel"
                  panelSection="workspace"
                  availableEnvironments={props.availableEnvironments}
                  {...(props.onEnvironmentChange
                    ? { onEnvironmentChange: props.onEnvironmentChange }
                    : {})}
                  autoEnvironmentLabel={props.autoEnvironmentLabel}
                  onAutoEnvironment={props.onAutoEnvironment}
                  {...branchToolbarProps}
                />
              ) : null}

              {density !== "essential" && props.showOpenInPicker ? (
                <OpenInPicker
                  keybindings={props.keybindings}
                  environmentId={props.environmentId}
                  availableEditors={props.availableEditors}
                  openInCwd={gitCwd}
                  enableShortcut={props.openInShortcutEnabled}
                  displayMode="panel"
                />
              ) : null}

              {props.activeProjectScripts ? (
                <ProjectScriptsControl
                  environmentId={props.environmentId}
                  displayMode="panel"
                  scripts={props.activeProjectScripts}
                  fileScripts={fileScripts}
                  preferredScriptId={props.preferredScriptId}
                  onRunScript={props.onRunProjectScript}
                  onAddScript={props.onAddProjectScript}
                  onUpdateScript={props.onUpdateProjectScript}
                  onDeleteScript={props.onDeleteProjectScript}
                />
              ) : null}
            </div>
          </ThreadDetailsSection>

          {activeRepository ? (
            <ThreadRepositoriesSection
              environmentId={props.environmentId}
              threadId={props.threadId}
              threadRef={threadRef}
            />
          ) : null}

          {gitCwd ? (
            <ThreadDetailsSection
              headingId="thread-details-version-control-heading"
              title="Version Control"
              showHeading={false}
              separated={density === "full"}
            >
              <div className="flex flex-col">
                {/* Every repository with work shows its own branch, pull requests, and Git
                    actions, so all of a multi-repository thread's pull requests are visible at
                    once. The server refuses branch moves on a repository set, so none of them
                    offers the branch picker. */}
                {repositoryBindings.length > 0 ? (
                  repositoryBindings.map((binding) => (
                    <RepositoryWithActivity
                      key={binding.id}
                      environmentId={props.environmentId}
                      threadRef={threadRef}
                      binding={binding}
                      active={binding.id === activeRepository?.id}
                    >
                      <div className="not-first:mt-1 not-first:border-t not-first:border-border/65 not-first:pt-1">
                        <RepositoryBranchRow
                          environmentId={props.environmentId}
                          binding={binding}
                        />
                        <RepositoryPullRequestRows
                          environmentId={props.environmentId}
                          threadRef={threadRef}
                          binding={binding}
                        />
                        {props.activeProjectName && binding.state === "ready" ? (
                          <GitActionsControl
                            key={binding.checkoutPath}
                            displayMode="panel"
                            compact={density !== "full"}
                            gitCwd={binding.checkoutPath}
                            activeThreadRef={activeThreadRef}
                            {...(props.onOpenChanges
                              ? {
                                  onOpenChanges: () => {
                                    useWorkspaceUiStore
                                      .getState()
                                      .setActiveRepository(scopedThreadKey(threadRef), binding.id);
                                    props.onOpenChanges?.();
                                  },
                                }
                              : {})}
                          />
                        ) : null}
                      </div>
                    </RepositoryWithActivity>
                  ))
                ) : (
                  <>
                    {props.isGitRepo ? (
                      <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                    ) : null}
                    {props.activeProjectName ? (
                      <GitActionsControl
                        key={gitCwd}
                        displayMode="panel"
                        compact={density !== "full"}
                        gitCwd={gitCwd}
                        activeThreadRef={activeThreadRef}
                        {...(props.draftId ? { draftId: props.draftId } : {})}
                        {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                      />
                    ) : null}
                  </>
                )}
              </div>
            </ThreadDetailsSection>
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
        </>
      )}
    </ThreadDetailsCard>
  );
}
