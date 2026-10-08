import { uuidv4 } from "../../lib/uuid";
import { useEffect, useRef, useState } from "react";
import { Alert, Switch, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { EnvironmentId, ProjectId, QuickAction, QuickActionFields } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  quickActionTargets,
  renderQuickActionSelection,
  type QuickActionChoice,
} from "@t3tools/client-runtime/quickActionRunner";
import { rankQuickActions } from "@t3tools/shared/quickActions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { forkWorkspace, quickActionsEnvironment } from "../../state/forkWorkspace";
import {
  captureComposerDraftInsertion,
  getComposerDraftSnapshot,
  insertComposerDraftText,
} from "../../state/use-composer-drafts";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/AppText";
import { ForkComposerSheet, ForkSheetButton } from "./ForkComposerSheet";

export function MobileQuickActions(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  draftKey: string;
  thread?: EnvironmentThreadShell;
  disabled?: boolean;
}) {
  const supported =
    useEnvironmentServerConfig(props.environmentId)?.environment.capabilities
      .forkQuickActionsVersion === 1;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<{
    action: QuickActionFields;
    revision: number | null;
  } | null>(null);
  const save = useAtomCommand(quickActionsEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(quickActionsEnvironment.remove, { reportFailure: false });
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const library = useEnvironmentQuery(
    open && supported
      ? quickActionsEnvironment.list({
          environmentId: props.environmentId,
          input: { projectId: props.projectId },
        })
      : null,
  );
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const resolve = useAtomCommand(forkWorkspace.context, { reportFailure: false });
  const scope = {
    environmentId: props.environmentId,
    projectId: props.projectId,
    thread: props.thread ?? null,
  };
  const run = async (action: QuickAction, choice: QuickActionChoice) => {
    if (busy) return;
    const invocation = ++generation.current;
    const target = captureComposerDraftInsertion(props.draftKey);
    setBusy(true);
    setError(null);
    try {
      const latest = await reload({
        environmentId: props.environmentId,
        input: { projectId: props.projectId },
      });
      if (latest._tag === "Failure") throw squashAtomCommandFailure(latest);
      const current = latest.value.find((entry) => entry.id === action.id && entry.enabled);
      if (!current || current.revision !== action.revision)
        throw new Error("This action changed. Refresh the list and select it again.");
      const rendered = await renderQuickActionSelection({
        action: current,
        scope,
        choices: [choice],
        readClipboard: Clipboard.getStringAsync,
        resolveContext: async (environmentId, input) => {
          const result = await resolve({ environmentId, input });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
      });
      if (invocation !== generation.current) return;
      if (getComposerDraftSnapshot(props.draftKey).text !== target.text)
        throw new Error("The draft changed while the action loaded. Select the action again.");
      const insertion = rendered.append
        ? { text: target.text, start: target.text.length, end: target.text.length }
        : target;
      insertComposerDraftText(
        props.draftKey,
        (rendered.append && target.text ? "\n\n" : "") + rendered.text,
        insertion,
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveEditor = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId: props.environmentId,
      input: { action: editing.action, expectedRevision: editing.revision },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      setEditing(null);
      library.refresh();
    }
    setBusy(false);
  };
  const deleteAction = (action: QuickAction) =>
    Alert.alert(`Delete ${action.name}?`, "This removes the action from this machine.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            setError(null);
            const result = await remove({
              environmentId: props.environmentId,
              input: { id: action.id, expectedRevision: action.revision },
            });
            if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
            else library.refresh();
            setBusy(false);
          })();
        },
      },
    ]);
  if (!supported) return null;
  return (
    <>
      <ComposerInlineControl
        label="Quick actions"
        icon="bolt.circle"
        disabled={props.disabled}
        onPress={() => {
          setOpen(true);
          setError(null);
        }}
      />
      {open ? (
        <ForkComposerSheet
          title="Quick actions"
          onClose={() => {
            generation.current++;
            setOpen(false);
            setEditing(null);
          }}
        >
          <ForkSheetButton
            label={managing ? "Use quick actions" : "Manage quick actions"}
            disabled={busy}
            onPress={() => {
              setManaging(!managing);
              setEditing(null);
            }}
          />
          {managing ? (
            <>
              <ForkSheetButton
                label="New quick action"
                disabled={busy}
                onPress={() =>
                  setEditing({
                    revision: null,
                    action: {
                      id: uuidv4(),
                      name: "",
                      template: "",
                      description: "",
                      aliases: [],
                      tags: [],
                      category: null,
                      projectId: props.projectId,
                      enabled: true,
                      favorite: false,
                    },
                  })
                }
              />
              {editing ? (
                <View className="gap-3">
                  <TextInput
                    accessibilityLabel="Action name"
                    placeholder="Name"
                    value={editing.action.name}
                    onChangeText={(name) =>
                      setEditing({ ...editing, action: { ...editing.action, name } })
                    }
                    className="rounded-xl bg-subtle p-3 text-foreground"
                  />
                  <TextInput
                    accessibilityLabel="Action template"
                    placeholder="Instructions, including {{variables}}"
                    multiline
                    value={editing.action.template}
                    onChangeText={(template) =>
                      setEditing({ ...editing, action: { ...editing.action, template } })
                    }
                    className="min-h-32 rounded-xl bg-subtle p-3 text-foreground"
                  />
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">Only this project</Text>
                    <Switch
                      accessibilityLabel="Only this project"
                      value={editing.action.projectId !== null}
                      onValueChange={(value) =>
                        setEditing({
                          ...editing,
                          action: { ...editing.action, projectId: value ? props.projectId : null },
                        })
                      }
                    />
                  </View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">Enabled</Text>
                    <Switch
                      accessibilityLabel="Enabled"
                      value={editing.action.enabled}
                      onValueChange={(enabled) =>
                        setEditing({ ...editing, action: { ...editing.action, enabled } })
                      }
                    />
                  </View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">Favorite</Text>
                    <Switch
                      accessibilityLabel="Favorite"
                      value={editing.action.favorite}
                      onValueChange={(favorite) =>
                        setEditing({ ...editing, action: { ...editing.action, favorite } })
                      }
                    />
                  </View>
                  <ForkSheetButton
                    label="Save action"
                    disabled={busy || !editing.action.name.trim()}
                    onPress={() => void saveEditor()}
                  />
                  <ForkSheetButton
                    label="Cancel edit"
                    disabled={busy}
                    onPress={() => setEditing(null)}
                  />
                </View>
              ) : (
                (library.data ?? []).map((action) => (
                  <View key={action.id} className="gap-2">
                    <ForkSheetButton
                      label={`Edit ${action.name}${action.enabled ? "" : " (disabled)"}`}
                      disabled={busy}
                      onPress={() => setEditing({ action, revision: action.revision })}
                    />
                    <ForkSheetButton
                      label={`Delete ${action.name}`}
                      disabled={busy}
                      onPress={() => deleteAction(action)}
                    />
                  </View>
                ))
              )}
            </>
          ) : null}
          {!managing ? (
            <TextInput
              accessibilityLabel="Search quick actions"
              placeholder="Search quick actions"
              value={query}
              onChangeText={setQuery}
              className="rounded-xl bg-subtle p-3 text-foreground"
            />
          ) : null}
          {library.isPending || busy ? (
            <Text className="text-foreground-muted">{busy ? "Preparing action…" : "Loading…"}</Text>
          ) : null}
          {error || library.error ? (
            <>
              <Text className="text-danger">{error ?? library.error}</Text>
              <ForkSheetButton
                label="Refresh"
                disabled={busy}
                onPress={() => {
                  setError(null);
                  library.refresh();
                }}
              />
            </>
          ) : null}
          {!library.isPending && !library.error && library.data?.length === 0 ? (
            <Text className="text-foreground-muted">No quick actions saved on this machine.</Text>
          ) : null}
          {!managing
            ? rankQuickActions(library.data ?? [], query).map((action) => {
                const targets = quickActionTargets(action, scope);
                return targets.kind === "unavailable" ? (
                  <Text key={action.id} className="text-foreground-muted">
                    {action.name} · {targets.reason}
                  </Text>
                ) : (
                  targets.variants.map((variant) => (
                    <ForkSheetButton
                      key={`${action.id}:${variant.key}`}
                      label={`${action.name}${variant.label ? ` · ${variant.label}` : ""}`}
                      disabled={busy}
                      onPress={() => void run(action, variant.choice)}
                    />
                  ))
                );
              })
            : null}
        </ForkComposerSheet>
      ) : null}
    </>
  );
}
