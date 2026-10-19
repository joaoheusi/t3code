import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ComponentProps } from "react";
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
  PullRequestRef,
  QuickAction,
  QuickActionFields,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  describeQuickActionTargets,
  pullRequestKnownState,
  pullRequestSignalStatuses,
  pullRequestTargetKey,
  quickActionSignals,
  quickActionTargets,
  renderQuickActionSelection,
  unresolvedReviewThreads,
  type QuickActionChoice,
  type QuickActionSignal,
  type QuickActionVariant,
} from "@t3tools/client-runtime/quickActionRunner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { rankQuickActionMenu } from "@t3tools/shared/quickActions";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { ControlPillMenu } from "../../components/ControlPillMenu";
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
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  captureComposerDraftInsertion,
  getComposerDraftSnapshot,
  insertComposerDraftText,
  setComposerSendRequested,
} from "../../state/use-composer-drafts";
import { MobileGitQuickAction, useQuickActionGitSummary } from "./MobileGitQuickAction";
import { MobileMergeQuickAction, useQuickActionMergeTargets } from "./MobileMergeQuickAction";
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
  readonly action: QuickAction;
  readonly subtitle: string | undefined;
  /** Null when the action cannot run here; the subtitle says why. */
  readonly variants: readonly QuickActionVariant[] | null;
  /** The single PR target whose status the row reports. */
  readonly statusTarget?: QuickActionVariant;
};
type Choosing = {
  readonly action: QuickAction;
  readonly variants: readonly QuickActionVariant[];
  readonly selected: readonly string[];
};

/**
 * A row whose subtitle adds the PR states its action acts on: failing CI, merge conflicts,
 * unresolved review threads, or a branch behind its base. Review threads and the base
 * comparison are not in the synced snapshot, so they load only for actions that need them.
 */
function QuickActionStatusRow({
  environmentId,
  projectId,
  variant,
  signals,
  subtitle,
  ...row
}: ComponentProps<typeof PickerRow> & {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly variant: QuickActionVariant | undefined;
  readonly signals: readonly QuickActionSignal[];
}) {
  const pullRequest = variant?.choice.pullRequest;
  const activity = useEnvironmentQuery(
    pullRequest && signals.includes("reviewThreads")
      ? pullRequestEnvironment.activity({ environmentId, input: { ...pullRequest, projectId } })
      : null,
  );
  const detail = useEnvironmentQuery(
    pullRequest && signals.includes("base")
      ? pullRequestEnvironment.detail({ environmentId, input: { ...pullRequest, projectId } })
      : null,
  );
  if (!pullRequest || signals.length === 0) return <PickerRow {...row} subtitle={subtitle} />;
  const statuses = pullRequestSignalStatuses(signals, {
    checks: variant.snapshot?.checksState,
    mergeability: variant.snapshot?.mergeability,
    baseComparison: detail.data?.baseComparison,
    behindBy: detail.data?.behindBy,
    reviewThreads: unresolvedReviewThreads(activity.data),
  });
  return (
    <PickerRow
      {...row}
      subtitle={[subtitle, ...statuses.map((status) => status.label)].filter(Boolean).join(" · ")}
      {...(statuses.some((status) => status.tone === "alert")
        ? { subtitleTone: "danger" as const }
        : {})}
    />
  );
}

export function useQuickActionsSupported(environmentId: EnvironmentId) {
  return (
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.forkQuickActionsVersion ===
    1
  );
}

/** The composer toolbar button that opens the quick action screen, beside attachments. */
export function QuickActionsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled?: boolean;
  readonly onOpen: () => void;
}) {
  const { scale } = useAndroidControlSizing();
  if (!useQuickActionsSupported(props.environmentId)) return null;
  return (
    <Pressable
      accessibilityLabel="Quick actions"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={props.onOpen}
    >
      <SymbolView
        name="bolt.circle"
        size={Math.round(20 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
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
    autoSend: false,
  },
});

/** Activity for a JSON `[environmentId, references]` key, in reference order. */
const pullRequestActivities = Atom.family((key: string) => {
  const [environmentId, references] = JSON.parse(key) as [EnvironmentId, PullRequestRef[]];
  return Atom.make((get) =>
    references.map((input) => get(pullRequestEnvironment.activity({ environmentId, input }))),
  );
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
  const [choosingGit, setChoosingGit] = useState(false);
  const [choosingMerge, setChoosingMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const canSave = useAtomValue(quickActionsEnvironment.save.permissionAtom(target.environmentId));
  const canRemove = useAtomValue(
    quickActionsEnvironment.remove.permissionAtom(target.environmentId),
  );
  const [choosing, setChoosing] = useState<Choosing | null>(null);
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
  const ranked = rankQuickActionMenu(actions, query);
  // Thread counts cost one activity read per open PR, so only load them when an action uses them.
  const readsReviewThreads = actions.some(
    (action) => action.enabled && quickActionSignals(action).includes("reviewThreads"),
  );
  const git = useQuickActionGitSummary(target);
  const merge = useQuickActionMergeTargets(target);
  const threadReferences =
    readsReviewThreads && merge.targets.kind === "ready"
      ? merge.targets.variants.flatMap((variant) =>
          variant.choice.pullRequest
            ? [{ ...variant.choice.pullRequest, projectId: target.projectId }]
            : [],
        )
      : [];
  const activities = useAtomValue(
    pullRequestActivities(JSON.stringify([target.environmentId, threadReferences])),
  );
  const fresh = new Map(
    threadReferences.map((reference, index) => {
      const result = activities[index];
      const activity = result ? Option.getOrNull(AsyncResult.value(result)) : null;
      return [pullRequestTargetKey(reference), pullRequestKnownState(null, activity)] as const;
    }),
  );
  const disabledActions = query.trim() ? [] : actions.filter((action) => !action.enabled);

  const run = async (action: QuickAction, choices: readonly QuickActionChoice[]) => {
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
        choices,
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
      if (current.autoSend) setComposerSendRequested(target.draftKey, true);
      void Haptics.selectionAsync();
      navigation.goBack();
    } catch (cause) {
      if (invocation === generation.current)
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

  const manageMenu = (action: QuickAction) =>
    [
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
    ].map((item) => ({
      ...item,
      attributes: {
        ...item.attributes,
        disabled: busy || !(item.id === "delete" ? canRemove : canSave),
      },
    }));

  const showMerge =
    !!thread &&
    query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .every((token) => "merge pull requests squash rebase".includes(token));
  const mergeAction = (isLast: boolean) => (
    <MobileMergeQuickAction
      key="merge"
      target={target}
      isLast={isLast}
      choosing={choosingMerge}
      onChoosingChange={setChoosingMerge}
    />
  );
  const gitAction = (isLast: boolean) => (
    <MobileGitQuickAction
      key="git"
      target={target}
      query={query}
      isLast={isLast}
      onClose={() => navigation.goBack()}
      choosing={choosingGit}
      onChoosingChange={setChoosingGit}
    />
  );
  if (choosingGit) return gitAction(true);
  if (choosingMerge) return mergeAction(true);

  if (editing && canSave) {
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
          editing.revision === null || !canRemove
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

  const listStyle = {
    gap: 12,
    paddingBottom: Math.max(insets.bottom, 16) + 16,
    paddingHorizontal: 16,
    paddingTop: 12,
  };

  if (choosing) {
    const { action, variants, selected } = choosing;
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ForkScreenHeader
          title={action.name}
          cancel={{
            label: "Back",
            onPress: () => {
              // Leaving the picker cancels a pending insert.
              generation.current++;
              setChoosing(null);
              setError(null);
            },
          }}
          action={{
            accessibilityLabel: "Insert selected",
            label: "Insert",
            icon: "checkmark",
            disabled: busy || selected.length === 0,
            onPress: () =>
              void run(
                action,
                variants
                  .filter((variant) => selected.includes(variant.key))
                  .map((variant) => variant.choice),
              ),
          }}
        />
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={listStyle}
        >
          <PickerCaption>
            {describeQuickActionTargets(action, variants) ?? "Choose where it applies"}
          </PickerCaption>
          <PickerSurface>
            {variants.map((variant, index) => (
              <QuickActionStatusRow
                key={variant.key}
                environmentId={target.environmentId}
                projectId={target.projectId}
                variant={variant}
                signals={quickActionSignals(action)}
                title={variant.label ?? action.name}
                symbol={
                  variant.choice.pullRequest
                    ? PullRequestGlyph.pullRequest
                    : "arrow.triangle.branch"
                }
                selected={selected.includes(variant.key)}
                accessibilityRole="checkbox"
                isLast={index === variants.length - 1}
                disabled={busy}
                onPress={() =>
                  setChoosing({
                    ...choosing,
                    selected: selected.includes(variant.key)
                      ? selected.filter((key) => key !== variant.key)
                      : [...selected, variant.key],
                  })
                }
              />
            ))}
          </PickerSurface>
          {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
          {busy ? (
            <View className="flex-row items-center justify-center gap-2">
              <ActivityIndicator size="small" />
              <Text className="text-sm text-foreground-muted">Preparing action…</Text>
            </View>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  // One row per action. An action with several PR or repository targets opens a picker that
  // shows each target's status, like the desktop palette's submenu.
  const actionRows = ranked.map((action): ActionRow => {
    const targets = quickActionTargets(action, scope, fresh);
    if (targets.kind === "unavailable") return { action, subtitle: targets.reason, variants: null };
    const [only] = targets.variants;
    if (targets.variants.length === 1 && only) {
      return {
        action,
        variants: targets.variants,
        statusTarget: only,
        subtitle: only.choice.pullRequest
          ? (only.label ?? undefined)
          : only.label || action.description || undefined,
      };
    }
    return {
      action,
      variants: targets.variants,
      subtitle:
        describeQuickActionTargets(action, targets.variants) ?? (action.description || undefined),
    };
  });
  // Available rows first, so dead ends never push actions out of view. The Git and Merge rows
  // join that order: busy and query-hidden states are transient, so they do not move a row.
  const gitAvailable = git.canWrite && !git.summary.disabled;
  const mergeAvailable = merge.canMerge && merge.targets.kind === "ready";
  const rows: Array<"git" | "merge" | ActionRow> = [
    ...(gitAvailable ? ["git" as const] : []),
    ...(showMerge && mergeAvailable ? ["merge" as const] : []),
    ...actionRows.filter((row) => row.variants),
    ...(gitAvailable ? [] : ["git" as const]),
    ...(showMerge && !mergeAvailable ? ["merge" as const] : []),
    ...actionRows.filter((row) => !row.variants),
  ];

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ForkScreenHeader
        title="Quick actions"
        action={{
          accessibilityLabel: "New quick action",
          disabled: !canSave || busy,
          icon: "plus",
          onPress: () => setEditing(newAction(target.projectId)),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={listStyle}
      >
        <PickerSearchField placeholder="Find an action" value={query} onChangeText={setQuery} />
        <PickerSurface>
          {rows.map((row, index) =>
            row === "git" ? (
              gitAction(index === rows.length - 1)
            ) : row === "merge" ? (
              mergeAction(index === rows.length - 1)
            ) : (
              <ControlPillMenu
                key={row.action.id}
                accessibilityLabel={`Manage ${row.action.name}`}
                shouldOpenOnLongPress
                actions={manageMenu(row.action)}
                onPressAction={({ nativeEvent }) =>
                  manage(row.action, nativeEvent.event as ManageAction)
                }
              >
                <QuickActionStatusRow
                  environmentId={target.environmentId}
                  projectId={target.projectId}
                  variant={row.statusTarget}
                  signals={quickActionSignals(row.action)}
                  multiline
                  title={row.action.name}
                  subtitle={row.subtitle}
                  symbol={row.action.favorite ? "star.fill" : "bolt.circle"}
                  dimmed={!row.variants}
                  trailing={
                    row.variants && row.variants.length > 1 ? (
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-icon-muted"
                        type="monochrome"
                      />
                    ) : undefined
                  }
                  isLast={index === rows.length - 1}
                  disabled={busy}
                  accessibilityHint={`${row.variants ? "Inserts the action into the message." : "Not available here."}${canSave ? " Long press to manage it." : ""}`}
                  onPress={() => {
                    const variants = row.variants;
                    if (!variants) Alert.alert(row.action.name, row.subtitle);
                    else if (variants.length === 1)
                      void run(
                        row.action,
                        variants.map((variant) => variant.choice),
                      );
                    else setChoosing({ action: row.action, variants, selected: [] });
                  }}
                />
              </ControlPillMenu>
            ),
          )}
        </PickerSurface>
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
        ) : actionRows.length === 0 && disabledActions.length === 0 && !showMerge ? (
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
            {busy ? (
              <View className="flex-row items-center justify-center gap-2">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-foreground-muted">Preparing action…</Text>
              </View>
            ) : null}
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
                        dimmed
                        symbol="bolt.circle"
                        isLast={index === disabledActions.length - 1}
                        disabled={busy || !canSave}
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
            title="Send immediately"
            value={action.autoSend}
            onValueChange={(autoSend) => update({ autoSend })}
          />
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
