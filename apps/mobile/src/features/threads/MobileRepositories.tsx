import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  draftRepositoryFrom,
  repositoryDefaultFrom,
  CHECKOUT_MODE_LABEL,
  WORKSPACE_STATE_LABEL,
  workspaceConfiguration,
  draftRepositoryFromBinding,
  isInsideFolder,
} from "@t3tools/client-runtime/workspaceModel";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { forkWorkspace } from "../../state/forkWorkspace";
import { serverEnvironment } from "../../state/server";
import { orchestrationEnvironment } from "../../state/orchestration";
import { uuidv4, randomHex } from "../../lib/uuid";
import { useMobileRepositories } from "./useMobileRepositories";
import { ForkComposerSheet, ForkSheetButton } from "./ForkComposerSheet";

export function MobileRepositories(props: {
  project: EnvironmentProject;
  draftKey: string;
  disabled?: boolean;
}) {
  const choice = useMobileRepositories(props.project, props.draftKey);
  const config = useEnvironmentServerConfig(props.project.environmentId);
  const projects = useProjects();
  const inspect = useAtomCommand(forkWorkspace.inspect, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { repositories, selection } = choice;
  const hasSavedDefault =
    (config?.settings.projectSettingsOverrides[props.project.id]?.workspaceRepositories?.length ??
      0) > 0;
  const total = repositories.length + (selection.folder ? 0 : 1);
  const add = async (repositoryPath = path) => {
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
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else setNotice(clear ? "Project default cleared." : "Saved as the project default.");
    setBusy(false);
  };
  if (!choice.supported) return null;
  return (
    <>
      <ComposerInlineControl
        label={
          choice.discovery.isPending
            ? "Loading folders…"
            : total > 1
              ? `${total} repositories`
              : total === 1 && selection.folder
                ? "1 repository"
                : "Repositories"
        }
        icon="folder"
        disabled={props.disabled}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <ForkComposerSheet title="Repositories" onClose={() => setOpen(false)}>
          <Text className="text-foreground">{props.project.title}</Text>
          <Text selectable className="text-foreground-muted">
            {props.project.workspaceRoot}
          </Text>
          <Text className="text-foreground-muted">
            The agent works across these repositories. They are prepared when you send the first
            message.
          </Text>
          {choice.foundCount > 20 ? (
            <Text className="text-foreground-muted">
              This folder contains {choice.foundCount} repositories. Only the first 20 are selected.
            </Text>
          ) : null}
          {choice.discovery.data?.limited ? (
            <Text className="text-foreground-muted">
              Discovery reached its limit. Add any missing repositories by path.
            </Text>
          ) : null}
          {repositories.map((repository) => (
            <View key={repository.path} className="gap-2 rounded-xl border border-border p-3">
              <View className="flex-row items-start gap-2">
                <View className="min-w-0 flex-1">
                  <Text className="text-foreground">{repository.label}</Text>
                  <Text selectable className="text-foreground-muted">
                    {repository.path}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel={`Remove ${repository.label}`}
                  accessibilityRole="button"
                  disabled={busy}
                  hitSlop={12}
                  className="p-1 active:opacity-60"
                  onPress={() =>
                    choice.setSelection({
                      ...selection,
                      repositories: selection.repositories.filter(
                        (entry) => entry.path !== repository.path,
                      ),
                    })
                  }
                >
                  <SymbolView
                    name="xmark"
                    size={14}
                    tintColorClassName="accent-icon-muted"
                    type="monochrome"
                  />
                </Pressable>
              </View>
              {repository.mode === "existing-worktree" ? (
                <Text className="text-foreground-muted">
                  {CHECKOUT_MODE_LABEL[repository.mode]} · used as it is
                </Text>
              ) : selection.folder &&
                isInsideFolder(props.project.workspaceRoot, repository.path) ? (
                <Text className="text-foreground-muted">
                  {CHECKOUT_MODE_LABEL[repository.mode]} · follows the folder setting
                </Text>
              ) : (
                <View className="flex-row items-center justify-between">
                  <Text className="text-foreground">New worktree</Text>
                  <ThemedSwitch
                    accessibilityLabel={`New worktree for ${repository.label}`}
                    disabled={busy}
                    value={repository.mode === "new-worktree"}
                    onValueChange={(newWorktree) =>
                      choice.setSelection({
                        ...selection,
                        repositories: selection.repositories.map((entry) =>
                          entry.path === repository.path
                            ? { ...entry, mode: newWorktree ? "new-worktree" : "current" }
                            : entry,
                        ),
                      })
                    }
                  />
                </View>
              )}
            </View>
          ))}
          {selection.folder ? (
            <Text className="text-foreground-muted">
              The workspace control chooses the current folder or a copy containing new worktrees
              for its repositories.
            </Text>
          ) : null}
          {projects
            .filter(
              (project) =>
                project.environmentId === props.project.environmentId &&
                project.id !== props.project.id &&
                !selection.repositories.some((entry) => entry.path === project.workspaceRoot),
            )
            .slice(0, 20)
            .map((project) => (
              <ForkSheetButton
                key={project.id}
                label={`Add ${project.title}`}
                disabled={busy || repositories.length >= (selection.folder ? 20 : 19)}
                onPress={() => void add(project.workspaceRoot)}
              />
            ))}
          <TextInput
            accessibilityLabel="Repository path on host"
            placeholder="Repository path on this machine"
            autoCapitalize="none"
            autoCorrect={false}
            value={path}
            onChangeText={setPath}
            className="rounded-xl bg-subtle p-3 text-foreground"
          />
          <ForkSheetButton
            label={busy ? "Working…" : "Add repository"}
            disabled={busy || !path.trim() || repositories.length >= (selection.folder ? 20 : 19)}
            onPress={() => void add()}
          />
          <ForkSheetButton
            label="Save as project default"
            disabled={busy}
            onPress={() => void saveDefault(false)}
          />
          <ForkSheetButton
            label="Clear project default"
            disabled={busy || !hasSavedDefault}
            onPress={() => void saveDefault(true)}
          />
          {notice ? <Text className="text-foreground-muted">{notice}</Text> : null}
          {error ? <Text className="text-danger">{error}</Text> : null}
          {choice.discovery.error ? (
            <>
              <Text className="text-danger">{choice.discovery.error}</Text>
              <ForkSheetButton label="Retry discovery" onPress={choice.discovery.refresh} />
            </>
          ) : null}
        </ForkComposerSheet>
      ) : null}
    </>
  );
}

type ThreadWorkspaceProps = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspace: ThreadWorkspace;
};

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

const repositoryCount = (count: number) =>
  `${count} ${count === 1 ? "repository" : "repositories"}`;

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
      <View className="gap-2 rounded-[20px] border-continuous bg-card p-4">
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
          {props.workspace.state === "failed"
            ? "Repository setup failed. Messages wait until it succeeds."
            : "Repository setup was cancelled. Messages wait until it is retried."}
        </Text>
        {failed ? (
          <Text selectable className="text-sm text-foreground-muted">
            {failed}
          </Text>
        ) : null}
        {control.error ? <Text className="text-sm text-danger">{control.error}</Text> : null}
        <View className="flex-row gap-2">
          <ForkSheetButton label="Retry setup" disabled={control.busy} onPress={control.retry} />
          {control.canCancel ? (
            <ForkSheetButton
              label="Cancel setup"
              disabled={control.busy}
              onPress={control.cancel}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function MobileThreadRepositories(props: ThreadWorkspaceProps) {
  const [open, setOpen] = useState(false);
  const control = useThreadWorkspaceControl(props);
  const stateLabel = WORKSPACE_STATE_LABEL[props.workspace.state];
  return (
    <>
      <ComposerInlineControl
        icon="folder"
        label={`${repositoryCount(props.workspace.bindings.length)}${stateLabel ? ` · ${stateLabel}` : ""}`}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <ForkComposerSheet title="Repositories" onClose={() => setOpen(false)}>
          {props.workspace.bindings.map((binding) => (
            <View key={binding.id} className="gap-2 p-2">
              <Text className="text-foreground">
                {binding.label}
                {WORKSPACE_STATE_LABEL[binding.state]
                  ? ` · ${WORKSPACE_STATE_LABEL[binding.state]}`
                  : ""}
              </Text>
              <Text selectable className="text-foreground-muted">
                {binding.checkoutPath}
              </Text>
              <Text className="text-foreground-muted">
                {binding.branch ?? "Detached HEAD"} · {CHECKOUT_MODE_LABEL[binding.mode]}
              </Text>
              {binding.error ? <Text className="text-danger">{binding.error}</Text> : null}
              <ForkSheetButton
                label="Copy path"
                onPress={() => void Clipboard.setStringAsync(binding.checkoutPath)}
              />
            </View>
          ))}
          {control.canRetry ? (
            <ForkSheetButton
              label="Retry preparation"
              disabled={control.busy}
              onPress={control.retry}
            />
          ) : null}
          {control.canCancel ? (
            <ForkSheetButton
              label="Cancel preparation"
              disabled={control.busy}
              onPress={control.cancel}
            />
          ) : null}
          {control.error ? <Text className="text-danger">{control.error}</Text> : null}
        </ForkComposerSheet>
      ) : null}
    </>
  );
}
