import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  EnvironmentId,
  ProjectId,
  QuickAction,
  QuickActionFields,
  ThreadId,
} from "@t3tools/contracts";
import {
  quickActionTargets,
  renderQuickActionSelection,
  type QuickActionChoice,
} from "@t3tools/client-runtime/quickActionRunner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { rankQuickActions } from "@t3tools/shared/quickActions";

import { AppText as Text } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import {
  PickerCaption,
  PickerRow,
  PickerSearchField,
  PickerSurface,
  PickerToggleRow,
} from "../../components/PickerList";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { forkWorkspace, quickActionsEnvironment } from "../../state/forkWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  captureComposerDraftInsertion,
  getComposerDraftSnapshot,
  insertComposerDraftText,
} from "../../state/use-composer-drafts";
import { ForkScreenHeader } from "./ForkScreenHeader";

export type QuickActionsTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  readonly threadId?: ThreadId;
};

type Editing = { readonly action: QuickActionFields; readonly revision: number | null };
type ManageAction = "edit" | "favorite" | "enable" | "delete";
type ActionRow = {
  readonly key: string;
  readonly action: QuickAction;
  readonly title: string;
  readonly subtitle: string | undefined;
  /** Null when the action cannot run here; the subtitle says why. */
  readonly choice: QuickActionChoice | null;
};

export function useQuickActionsSupported(environmentId: EnvironmentId) {
  return (
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.forkQuickActionsVersion ===
    1
  );
}

/** The composer control that opens the quick action screen. */
export function QuickActionsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled?: boolean;
  readonly onOpen: () => void;
}) {
  if (!useQuickActionsSupported(props.environmentId)) return null;
  return (
    <ComposerInlineControl
      label="Actions"
      accessibilityLabel="Quick actions"
      icon="bolt.circle"
      disabled={props.disabled}
      onPress={props.onOpen}
    />
  );
}

const newAction = (projectId: ProjectId): Editing => ({
  revision: null,
  action: {
    id: uuidv4() as QuickActionFields["id"],
    name: "",
    template: "",
    description: "",
    aliases: [],
    tags: [],
    category: null,
    projectId,
    enabled: true,
    favorite: false,
  },
});

/** Lists quick actions to insert into the composer, and creates or edits them. */
export function QuickActionsScreen({ route }: StaticScreenProps<QuickActionsTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const thread = useThreadShell(
    target.threadId ? { environmentId: target.environmentId, threadId: target.threadId } : null,
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const save = useAtomCommand(quickActionsEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(quickActionsEnvironment.remove, { reportFailure: false });
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const resolve = useAtomCommand(forkWorkspace.context, { reportFailure: false });
  const library = useEnvironmentQuery(
    quickActionsEnvironment.list({
      environmentId: target.environmentId,
      input: { projectId: target.projectId },
    }),
  );
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const scope = {
    environmentId: target.environmentId,
    projectId: target.projectId,
    thread,
  };
  const actions = library.data ?? [];
  const ranked = rankQuickActions(actions, query);
  const disabledActions = query.trim() ? [] : actions.filter((action) => !action.enabled);

  const run = async (action: QuickAction, choice: QuickActionChoice) => {
    if (busy) return;
    const invocation = ++generation.current;
    const insertion = captureComposerDraftInsertion(target.draftKey);
    setBusy(true);
    setError(null);
    try {
      const latest = await reload({
        environmentId: target.environmentId,
        input: { projectId: target.projectId },
      });
      if (latest._tag === "Failure") throw squashAtomCommandFailure(latest);
      const current = latest.value.find((entry) => entry.id === action.id && entry.enabled);
      if (!current || current.revision !== action.revision)
        throw new Error("This action changed. Pull to refresh and select it again.");
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
      if (getComposerDraftSnapshot(target.draftKey).text !== insertion.text)
        throw new Error("The draft changed while the action loaded. Select the action again.");
      insertComposerDraftText(
        target.draftKey,
        (rendered.append && insertion.text ? "\n\n" : "") + rendered.text,
        rendered.append
          ? { text: insertion.text, start: insertion.text.length, end: insertion.text.length }
          : insertion,
      );
      void Haptics.selectionAsync();
      navigation.goBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const persist = async (action: QuickActionFields, expectedRevision: number | null) => {
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId: target.environmentId,
      input: { action, expectedRevision },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return false;
    }
    library.refresh();
    return true;
  };

  const confirmDelete = (action: QuickAction) =>
    Alert.alert(`Delete “${action.name}”?`, "This removes the action from this machine.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            setError(null);
            const result = await remove({
              environmentId: target.environmentId,
              input: { id: action.id, expectedRevision: action.revision },
            });
            setBusy(false);
            if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
            else {
              setEditing(null);
              library.refresh();
            }
          })();
        },
      },
    ]);

  const manage = (action: QuickAction, choice: ManageAction) => {
    if (choice === "edit") setEditing({ action, revision: action.revision });
    else if (choice === "delete") confirmDelete(action);
    else
      void persist(
        choice === "favorite"
          ? { ...action, favorite: !action.favorite }
          : { ...action, enabled: !action.enabled },
        action.revision,
      );
  };

  const manageMenu = (action: QuickAction) => [
    { id: "edit", title: "Edit", image: Platform.OS === "ios" ? "pencil" : "edit" },
    {
      id: "favorite",
      title: action.favorite ? "Remove from favorites" : "Add to favorites",
      image: Platform.OS === "ios" ? (action.favorite ? "star.slash" : "star") : "star",
    },
    {
      id: "enable",
      title: action.enabled ? "Disable" : "Enable",
      image: Platform.OS === "ios" ? (action.enabled ? "eye.slash" : "eye") : "visibility",
    },
    {
      id: "delete",
      title: "Delete",
      image: Platform.OS === "ios" ? "trash" : "delete",
      attributes: { destructive: true },
    },
  ];

  if (editing) {
    return (
      <QuickActionEditor
        editing={editing}
        busy={busy}
        error={error}
        onChange={setEditing}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onSave={async () => {
          if (await persist(editing.action, editing.revision)) setEditing(null);
        }}
        onDelete={
          editing.revision === null
            ? undefined
            : () => {
                const action = actions.find((entry) => entry.id === editing.action.id);
                if (action) confirmDelete(action);
              }
        }
        projectId={target.projectId}
      />
    );
  }

  // Each runnable choice is one row; an action that needs a pull request or repository
  // offers one row per candidate.
  const rows = ranked.flatMap((action): ActionRow[] => {
    const targets = quickActionTargets(action, scope);
    if (targets.kind === "unavailable") {
      return [
        { key: action.id, action, title: action.name, subtitle: targets.reason, choice: null },
      ];
    }
    return targets.variants.map((variant) => ({
      key: `${action.id}:${variant.key}`,
      action,
      title: action.name,
      subtitle: variant.label || action.description || undefined,
      choice: variant.choice,
    }));
  });

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ForkScreenHeader
        title="Quick actions"
        action={{
          accessibilityLabel: "New quick action",
          icon: "plus",
          onPress: () => setEditing(newAction(target.projectId)),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          gap: 12,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 12,
        }}
      >
        <PickerSearchField placeholder="Find an action" value={query} onChangeText={setQuery} />
        {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
        {library.error ? (
          <View className="items-center gap-3 py-8">
            <Text className="text-center text-sm text-foreground-muted">{library.error}</Text>
            <Pressable
              accessibilityRole="button"
              className="rounded-full bg-card px-4 py-2 active:opacity-70"
              onPress={library.refresh}
            >
              <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : library.isPending && !library.data ? (
          <View className="items-center py-8">
            <ActivityIndicator />
          </View>
        ) : rows.length === 0 && disabledActions.length === 0 ? (
          <View className="items-center gap-1 px-6 py-10">
            <Text className="text-center text-base font-t3-medium text-foreground">
              {query.trim() ? "No matching actions" : "No quick actions yet"}
            </Text>
            {query.trim() ? null : (
              <Text className="text-center text-sm text-foreground-muted">
                Save instructions you use often, then insert them here.
              </Text>
            )}
          </View>
        ) : (
          <>
            {rows.length > 0 ? (
              <PickerSurface>
                {rows.map((row, index) => (
                  <ControlPillMenu
                    key={row.key}
                    accessibilityLabel={`Manage ${row.title}`}
                    shouldOpenOnLongPress
                    actions={manageMenu(row.action)}
                    onPressAction={({ nativeEvent }) =>
                      manage(row.action, nativeEvent.event as ManageAction)
                    }
                  >
                    <PickerRow
                      title={row.title}
                      subtitle={row.subtitle}
                      symbol={row.action.favorite ? "star.fill" : "bolt.circle"}
                      isLast={index === rows.length - 1}
                      disabled={busy}
                      accessibilityHint="Inserts the action into the message. Long press to manage it."
                      onPress={() =>
                        row.choice
                          ? void run(row.action, row.choice)
                          : Alert.alert(row.title, row.subtitle)
                      }
                    />
                  </ControlPillMenu>
                ))}
              </PickerSurface>
            ) : null}
            {busy ? (
              <View className="flex-row items-center justify-center gap-2">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-foreground-muted">Preparing action…</Text>
              </View>
            ) : (
              <PickerCaption>
                Inserting never sends. Long press an action to edit, favorite, or delete it.
              </PickerCaption>
            )}
            {disabledActions.length > 0 ? (
              <View className="gap-2">
                <PickerCaption>Disabled</PickerCaption>
                <PickerSurface>
                  {disabledActions.map((action, index) => (
                    <ControlPillMenu
                      key={action.id}
                      accessibilityLabel={`Manage ${action.name}`}
                      shouldOpenOnLongPress
                      actions={manageMenu(action)}
                      onPressAction={({ nativeEvent }) =>
                        manage(action, nativeEvent.event as ManageAction)
                      }
                    >
                      <PickerRow
                        title={action.name}
                        subtitle="Disabled"
                        symbol="bolt.circle"
                        isLast={index === disabledActions.length - 1}
                        disabled={busy}
                        onPress={() => setEditing({ action, revision: action.revision })}
                      />
                    </ControlPillMenu>
                  ))}
                </PickerSurface>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function QuickActionEditor(props: {
  readonly editing: Editing;
  readonly busy: boolean;
  readonly error: string | null;
  readonly projectId: ProjectId;
  readonly onChange: (editing: Editing) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onDelete?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { action } = props.editing;
  const update = (patch: Partial<QuickActionFields>) =>
    props.onChange({ ...props.editing, action: { ...action, ...patch } });
  const fieldClassName = "px-4 py-3 font-sans text-base text-foreground";
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ForkScreenHeader
        title={props.editing.revision === null ? "New action" : "Edit action"}
        cancel={{ label: "Cancel", onPress: props.onCancel }}
        action={{
          accessibilityLabel: "Save action",
          label: "Save",
          icon: "checkmark",
          disabled: props.busy || !action.name.trim(),
          onPress: props.onSave,
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          gap: 12,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 12,
        }}
      >
        <PickerSurface>
          <TextInput
            accessibilityLabel="Name"
            placeholder="Name"
            placeholderTextColorClassName="accent-placeholder"
            value={action.name}
            onChangeText={(name) => update({ name })}
            className={`${fieldClassName} border-b border-border-subtle`}
          />
          <TextInput
            accessibilityLabel="Description"
            placeholder="Description (optional)"
            placeholderTextColorClassName="accent-placeholder"
            value={action.description}
            onChangeText={(description) => update({ description })}
            className={fieldClassName}
          />
        </PickerSurface>
        <PickerSurface>
          <TextInput
            accessibilityLabel="Instructions"
            placeholder="Instructions"
            placeholderTextColorClassName="accent-placeholder"
            multiline
            textAlignVertical="top"
            value={action.template}
            onChangeText={(template) => update({ template })}
            className={`${fieldClassName} min-h-40`}
          />
        </PickerSurface>
        <PickerCaption>
          {
            "Variables such as {{clipboard}}, {{repo.branch}}, and {{pr.url}} are filled in when you insert the action."
          }
        </PickerCaption>
        <PickerSurface>
          <PickerToggleRow
            title="Favorite"
            value={action.favorite}
            onValueChange={(favorite) => update({ favorite })}
          />
          <PickerToggleRow
            title="Only this project"
            value={action.projectId !== null}
            onValueChange={(only) => update({ projectId: only ? props.projectId : null })}
          />
          <PickerToggleRow
            title="Enabled"
            isLast
            value={action.enabled}
            onValueChange={(enabled) => update({ enabled })}
          />
        </PickerSurface>
        {props.error ? <PickerCaption tone="danger">{props.error}</PickerCaption> : null}
        {props.onDelete ? (
          <PickerSurface>
            <PickerRow
              title="Delete action"
              tone="danger"
              symbol="trash"
              isLast
              disabled={props.busy}
              onPress={props.onDelete}
            />
          </PickerSurface>
        ) : null}
      </ScrollView>
    </View>
  );
}
