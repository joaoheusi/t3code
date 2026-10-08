import { type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CHECKOUT_MODE_LABEL,
  REPOSITORY_LIMIT,
  WORKSPACE_STATE_LABEL,
  draftRepositoryFrom,
  draftRepositoryFromBinding,
  isInsideFolder,
  repositoryDefaultFrom,
  workspaceConfiguration,
} from "@t3tools/client-runtime/workspaceModel";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import {
  PickerCaption,
  PickerRow,
  PickerSearchField,
  PickerSurface,
} from "../../components/PickerList";
import { randomHex, uuidv4 } from "../../lib/uuid";
import {
  useEnvironmentServerConfig,
  useProject,
  useProjects,
  useThreadShell,
} from "../../state/entities";
import { forkWorkspace } from "../../state/forkWorkspace";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ForkScreenHeader } from "./ForkScreenHeader";
import { useMobileRepositories } from "./useMobileRepositories";

export type RepositoriesTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
};

export type ThreadRepositoriesTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
};

const repositoryCount = (count: number) =>
  `${count} ${count === 1 ? "repository" : "repositories"}`;

/** Host paths read better on a phone with the home folder shortened. */
const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

/** The new-task composer control that opens the repositories screen. */
export function RepositoriesControl(props: {
  readonly project: EnvironmentProject;
  readonly draftKey: string;
  readonly disabled?: boolean;
  readonly onOpen: () => void;
}) {
  const choice = useMobileRepositories(props.project, props.draftKey);
  if (!choice.supported) return null;
  const total = choice.repositories.length + (choice.selection.folder ? 0 : 1);
  return (
    <ComposerInlineControl
      accessibilityLabel={`Repositories: ${repositoryCount(total)}`}
      label={
        choice.discovery.isPending && !choice.discovery.data
          ? "Finding repositories…"
          : total > 1 || choice.selection.folder
            ? repositoryCount(total)
            : "Repositories"
      }
      icon="folder"
      disabled={props.disabled}
      onPress={props.onOpen}
    />
  );
}

/** Chooses the repositories a new task prepares with its first message. */
export function RepositoriesScreen({ route }: StaticScreenProps<RepositoriesTarget>) {
  const target = route.params;
  const project = useProject({ environmentId: target.environmentId, projectId: target.projectId });
  if (!project) return null;
  return <RepositoriesContent project={project} draftKey={target.draftKey} />;
}

function RepositoriesContent(props: {
  readonly project: EnvironmentProject;
  readonly draftKey: string;
}) {
  const insets = useSafeAreaInsets();
  const choice = useMobileRepositories(props.project, props.draftKey);
  const config = useEnvironmentServerConfig(props.project.environmentId);
  const projects = useProjects();
  const inspect = useAtomCommand(forkWorkspace.inspect, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { repositories, selection } = choice;
  const limit = selection.folder ? REPOSITORY_LIMIT : REPOSITORY_LIMIT - 1;
  const full = repositories.length >= limit;
  const hasSavedDefault =
    (config?.settings.projectSettingsOverrides[props.project.id]?.workspaceRepositories?.length ??
      0) > 0;

  const add = async (repositoryPath: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await inspect({
        environmentId: props.project.environmentId,
        input: { path: repositoryPath.trim() },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const repository = result.value;
      if (
        repository.path === props.project.workspaceRoot ||
        choice.discovery.data?.repositories.some(
          (entry) =>
            entry.path === props.project.workspaceRoot && entry.commonDir === repository.commonDir,
        ) ||
        repositories.some((entry) => entry.commonDir === repository.commonDir)
      )
        throw new Error("This repository is already included.");
      choice.setSelection({
        ...selection,
        repositories: [
          ...selection.repositories,
          {
            ...repositoryDefaultFrom(draftRepositoryFrom(repository, repository.path)),
            branch: repository.branch,
            head: repository.head,
          },
        ],
      });
      void Haptics.selectionAsync();
      setPath("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveDefault = async (clear: boolean) => {
    if (!config) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await save({
      environmentId: props.project.environmentId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [props.project.id]: clear
              ? clearProjectSettingsOverrides(config.settings, props.project.id, [
                  "workspaceRepositories",
                ])
              : {
                  ...config.settings.projectSettingsOverrides[props.project.id],
                  workspaceRepositories: repositories.map(repositoryDefaultFrom),
                },
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else setNotice(clear ? "Project default cleared." : "Saved as the project default.");
  };

  const setMode = (repositoryPath: string, mode: "current" | "new-worktree") =>
    choice.setSelection({
      ...selection,
      repositories: selection.repositories.map((entry) =>
        entry.path === repositoryPath ? { ...entry, mode } : entry,
      ),
    });
  const removeRepository = (repositoryPath: string) =>
    choice.setSelection({
      ...selection,
      repositories: selection.repositories.filter((entry) => entry.path !== repositoryPath),
    });

  const needle = query.trim().toLocaleLowerCase();
  const candidates = projects.filter(
    (project) =>
      project.environmentId === props.project.environmentId &&
      project.id !== props.project.id &&
      !selection.repositories.some((entry) => entry.path === project.workspaceRoot) &&
      (!needle ||
        project.title.toLocaleLowerCase().includes(needle) ||
        project.workspaceRoot.toLocaleLowerCase().includes(needle)),
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ForkScreenHeader title="Repositories" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          gap: 8,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 12,
        }}
      >
        <PickerSurface>
          {selection.folder ? null : (
            <PickerRow
              title={props.project.title}
              subtitle="This project · follows the workspace control"
              symbol="folder"
              isLast={repositories.length === 0}
            />
          )}
          {repositories.map((repository, index) => {
            const followsFolder =
              selection.folder && isInsideFolder(props.project.workspaceRoot, repository.path);
            const canSwitch = repository.mode !== "existing-worktree" && !followsFolder;
            return (
              <ControlPillMenu
                key={repository.path}
                accessibilityLabel={`Options for ${repository.label}`}
                actions={[
                  ...(canSwitch
                    ? [
                        {
                          id: "current",
                          title: CHECKOUT_MODE_LABEL.current,
                          state: repository.mode === "current" ? ("on" as const) : undefined,
                        },
                        {
                          id: "new-worktree",
                          title: CHECKOUT_MODE_LABEL["new-worktree"],
                          state: repository.mode === "new-worktree" ? ("on" as const) : undefined,
                        },
                      ]
                    : []),
                  {
                    id: "remove",
                    title: "Remove",
                    image: Platform.OS === "ios" ? "minus.circle" : "remove",
                    attributes: { destructive: true },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  const id = nativeEvent.event;
                  if (id === "remove") removeRepository(repository.path);
                  else if (id === "current" || id === "new-worktree") setMode(repository.path, id);
                }}
              >
                <PickerRow
                  title={repository.label}
                  subtitle={`${
                    followsFolder ? "Follows the folder" : CHECKOUT_MODE_LABEL[repository.mode]
                  } · ${shortPath(repository.path)}`}
                  symbol="arrow.triangle.branch"
                  disabled={busy}
                  isLast={index === repositories.length - 1}
                  accessibilityHint="Opens checkout options"
                  trailing={
                    <SymbolView
                      name="chevron.down"
                      size={14}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                    />
                  }
                />
              </ControlPillMenu>
            );
          })}
          {selection.folder && repositories.length === 0 ? (
            <PickerRow title="No repositories selected" subtitle="Add one below" isLast />
          ) : null}
        </PickerSurface>
        <PickerCaption>
          {selection.folder
            ? "The workspace control under the composer chooses the current folder or a copy with new worktrees. "
            : ""}
          Repositories are prepared when you send the first message.
          {choice.foundCount > REPOSITORY_LIMIT
            ? ` This folder has ${choice.foundCount} repositories; the first ${REPOSITORY_LIMIT} are selected.`
            : ""}
          {choice.discovery.data?.limited
            ? " Discovery stopped early; add missing ones by path."
            : ""}
        </PickerCaption>
        {choice.discovery.isPending && !choice.discovery.data ? (
          <View className="flex-row items-center gap-2 px-4">
            <ActivityIndicator size="small" />
            <Text className="text-xs text-foreground-muted">Finding repositories…</Text>
          </View>
        ) : null}
        {choice.discovery.error ? (
          <View className="flex-row items-center justify-between gap-3 px-4">
            <Text className="min-w-0 flex-1 text-xs text-danger">{choice.discovery.error}</Text>
            <Pressable
              accessibilityRole="button"
              className="rounded-full bg-card px-3 py-1.5 active:opacity-70"
              onPress={choice.discovery.refresh}
            >
              <Text className="text-xs font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : null}

        <Text className="mt-4 px-4 text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
          Add a repository
        </Text>
        <PickerSearchField placeholder="Find a project" value={query} onChangeText={setQuery} />
        <PickerSurface>
          {candidates.slice(0, needle ? 50 : 8).map((project) => (
            <PickerRow
              key={project.id}
              title={project.title}
              subtitle={shortPath(project.workspaceRoot)}
              symbol="plus"
              disabled={busy || full}
              onPress={() => void add(project.workspaceRoot)}
            />
          ))}
          <View className="min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-2">
            <TextInput
              accessibilityLabel="Repository path on this machine"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Or enter a path on this machine"
              placeholderTextColorClassName="accent-placeholder"
              returnKeyType="done"
              value={path}
              onChangeText={setPath}
              onSubmitEditing={() => path.trim() && void add(path)}
              className="min-w-0 flex-1 py-2 font-sans text-base text-foreground"
            />
            {busy ? (
              <ActivityIndicator size="small" />
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={!path.trim() || full}
                hitSlop={8}
                onPress={() => void add(path)}
                style={{ opacity: !path.trim() || full ? 0.4 : 1 }}
              >
                <Text className="text-base font-t3-medium text-primary-text">Add</Text>
              </Pressable>
            )}
          </View>
        </PickerSurface>
        {full ? (
          <PickerCaption>A task can use up to {REPOSITORY_LIMIT} repositories.</PickerCaption>
        ) : null}
        {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}

        <Text className="mt-4 px-4 text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
          Project default
        </Text>
        <PickerSurface>
          <PickerRow
            title="Save as project default"
            tone="accent"
            disabled={busy}
            onPress={() => void saveDefault(false)}
          />
          <PickerRow
            title="Clear project default"
            tone="accent"
            isLast
            disabled={busy || !hasSavedDefault}
            onPress={() => void saveDefault(true)}
          />
        </PickerSurface>
        <PickerCaption>
          {notice ?? "New tasks in this project start with the saved repositories."}
        </PickerCaption>
      </ScrollView>
    </View>
  );
}

type ThreadWorkspaceProps = ThreadRepositoriesTarget & { readonly workspace: ThreadWorkspace };

/** Retry or cancel a thread's repository preparation. */
function useThreadWorkspaceControl(props: ThreadWorkspaceProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const control = async (type: "retry" | "cancel") => {
    setBusy(true);
    const result = await dispatch({
      environmentId: props.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(uuidv4()),
        threadId: props.threadId,
        ...(type === "retry" && props.workspace.state === "cancelled"
          ? {
              workspaceConfiguration: workspaceConfiguration({
                randomHex,
                primary: null,
                ...(props.workspace.root
                  ? {
                      root: {
                        sourcePath: props.workspace.root.sourcePath,
                        mode: props.workspace.root.mode,
                      },
                    }
                  : {}),
                repositories: props.workspace.bindings.map(draftRepositoryFromBinding),
                expectedRevision: props.workspace.revision,
              }),
            }
          : { workspaceControl: { type, expectedRevision: props.workspace.revision } }),
      },
    });
    setError(result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null);
    setBusy(false);
  };
  return {
    error,
    busy,
    canRetry: props.workspace.state === "failed" || props.workspace.state === "cancelled",
    canCancel: ["planned", "validating", "preparing", "failed"].includes(props.workspace.state),
    retry: () => void control("retry"),
    cancel: () => void control("cancel"),
  };
}

function NoticeButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.primary
          ? "rounded-full bg-primary px-4 py-2 active:opacity-70"
          : "rounded-full bg-subtle px-4 py-2 active:opacity-70"
      }
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      <Text
        className={
          props.primary
            ? "text-sm font-t3-medium text-primary-foreground"
            : "text-sm font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * Shown above the composer when preparation stopped. The first message stays queued until
 * the repositories are ready, so this is the way forward.
 */
export function MobileThreadWorkspaceNotice(props: ThreadWorkspaceProps) {
  const control = useThreadWorkspaceControl(props);
  if (!control.canRetry) return null;
  const failed = props.workspace.bindings.find((binding) => binding.error)?.error;
  return (
    <View className="px-4 pb-3">
      <View className="gap-3 rounded-[20px] border-continuous bg-card p-4">
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
          {props.workspace.state === "failed"
            ? "Repository setup failed. Messages wait until it succeeds."
            : "Repository setup was cancelled. Messages wait until it is retried."}
        </Text>
        {failed ? (
          <Text selectable numberOfLines={3} className="text-xs text-foreground-muted">
            {failed}
          </Text>
        ) : null}
        {control.error ? <Text className="text-xs text-danger">{control.error}</Text> : null}
        <View className="flex-row gap-2">
          <NoticeButton
            label="Retry setup"
            primary
            disabled={control.busy}
            onPress={control.retry}
          />
          {control.canCancel ? (
            <NoticeButton label="Cancel" disabled={control.busy} onPress={control.cancel} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** The thread composer control showing repository preparation, opening its screen. */
export function ThreadRepositoriesControl(props: {
  readonly workspace: ThreadWorkspace;
  readonly onOpen: () => void;
}) {
  const stateLabel = WORKSPACE_STATE_LABEL[props.workspace.state];
  return (
    <ComposerInlineControl
      icon="folder"
      label={`${repositoryCount(props.workspace.bindings.length)}${stateLabel ? ` · ${stateLabel}` : ""}`}
      onPress={props.onOpen}
    />
  );
}

/** A started thread's repositories and their preparation. */
export function ThreadRepositoriesScreen({ route }: StaticScreenProps<ThreadRepositoriesTarget>) {
  const target = route.params;
  const thread = useThreadShell(target);
  if (!thread?.workspace) return null;
  return <ThreadRepositoriesContent {...target} workspace={thread.workspace} />;
}

function ThreadRepositoriesContent(props: ThreadWorkspaceProps) {
  const insets = useSafeAreaInsets();
  const control = useThreadWorkspaceControl(props);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (path: string) => {
    void Clipboard.setStringAsync(path);
    void Haptics.selectionAsync();
    setCopied(path);
  };
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ForkScreenHeader title="Repositories" />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          gap: 8,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 12,
        }}
      >
        <PickerSurface>
          {props.workspace.bindings.map((binding, index) => {
            const state = WORKSPACE_STATE_LABEL[binding.state];
            return (
              <PickerRow
                key={binding.id}
                title={binding.label}
                subtitle={[
                  state,
                  binding.branch ?? "Detached HEAD",
                  CHECKOUT_MODE_LABEL[binding.mode],
                ]
                  .filter(Boolean)
                  .join(" · ")}
                symbol={
                  binding.state === "failed" ? "exclamationmark.triangle" : "arrow.triangle.branch"
                }
                isLast={index === props.workspace.bindings.length - 1}
                accessibilityHint="Copies the checkout path"
                trailing={
                  <Text className="text-sm text-foreground-muted">
                    {copied === binding.checkoutPath ? "Copied" : "Copy path"}
                  </Text>
                }
                onPress={() => copy(binding.checkoutPath)}
              />
            );
          })}
        </PickerSurface>
        {props.workspace.bindings
          .filter((binding) => binding.error)
          .map((binding) => (
            <PickerCaption key={binding.id} tone="danger">
              {binding.label}: {binding.error}
            </PickerCaption>
          ))}
        {control.canRetry || control.canCancel ? (
          <PickerSurface className="mt-4">
            {control.canRetry ? (
              <PickerRow
                title="Retry preparation"
                tone="accent"
                symbol="arrow.clockwise"
                isLast={!control.canCancel}
                disabled={control.busy}
                onPress={control.retry}
              />
            ) : null}
            {control.canCancel ? (
              <PickerRow
                title="Cancel preparation"
                tone="danger"
                symbol="xmark"
                isLast
                disabled={control.busy}
                onPress={control.cancel}
              />
            ) : null}
          </PickerSurface>
        ) : null}
        {control.error ? <PickerCaption tone="danger">{control.error}</PickerCaption> : null}
      </ScrollView>
    </View>
  );
}
