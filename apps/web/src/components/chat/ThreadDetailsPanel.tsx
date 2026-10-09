import {
  type EditorId,
  type EnvironmentId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import type { ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  RepositoryBranchRow,
  RepositoryPullRequestRows,
  ThreadRepositoriesSection,
  useActiveRepository,
} from "../../workspace/ThreadRepositoriesSection";

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  /** The thread's env mode as ChatView resolves it. */
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
  // A multi-repository thread lists its repositories, and Git acts on the one picked there.
  const activeRepository = useActiveRepository(props.draftId ? null : threadRef);
  const gitCwd = activeRepository?.checkoutPath ?? props.gitCwd;
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
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
                  onEnvironmentChange={props.onEnvironmentChange}
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
                {/* Each repository shows its own branch and pull requests. The server refuses
                    branch moves on a repository set, so none of them offers the branch picker. */}
                {activeRepository ? (
                  <>
                    <RepositoryBranchRow
                      environmentId={props.environmentId}
                      binding={activeRepository}
                    />
                    <RepositoryPullRequestRows
                      environmentId={props.environmentId}
                      threadRef={threadRef}
                      binding={activeRepository}
                    />
                  </>
                ) : props.isGitRepo ? (
                  <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                ) : null}
                {props.activeProjectName ? (
                  <GitActionsControl
                    key={gitCwd}
                    displayMode="panel"
                    compact={density !== "full"}
                    gitCwd={gitCwd}
                    activeThreadRef={{
                      environmentId: props.environmentId,
                      threadId: props.threadId,
                    }}
                    {...(props.draftId ? { draftId: props.draftId } : {})}
                    {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                  />
                ) : null}
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
