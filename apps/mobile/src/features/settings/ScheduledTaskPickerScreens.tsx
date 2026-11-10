import { useNavigation } from "@react-navigation/native";
import { REPOSITORY_LIMIT } from "@t3tools/client-runtime/workspaceModel";
import { isListedThreadLineage } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { FlatList, Platform, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useSearchToolbarInset } from "../../components/ui/useBarInset";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import {
  useEnvironmentServerConfig,
  useProjects,
  useVisibleThreadShells,
} from "../../state/entities";
import { useDebouncedValue, usePaginatedBranches, useThreadSearch } from "../../state/queries";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useScheduledTaskRepositories } from "./useScheduledTaskRepositories";
import {
  NEW_THREAD_DESTINATION_LABEL,
  useScheduledTaskDestinationLabel,
  useScheduledTaskEditor,
} from "./scheduled-task-editor";
import { moveDraftToThread, unbindDraftFromThread } from "./scheduledTaskDraft";

function MissingTaskDraft() {
  return (
    <SettingsScreen title="Scheduled task">
      <Text className="p-5 text-base text-foreground-muted">Open a scheduled task form first.</Text>
    </SettingsScreen>
  );
}

export function ScheduledTaskModelPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, setEditor } = useScheduledTaskEditor();
  const config = useEnvironmentServerConfig(editor?.environmentId ?? null);
  const selectedModel = editor?.draft.modelSelection ?? null;
  const projectId = editor?.draft.projectId ?? null;
  const models = useMemo(
    () => buildModelOptions(config, selectedModel, undefined, projectId),
    [config, selectedModel, projectId],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selectedModel?.options,
      }),
    [selectedOption?.capabilities, selectedModel?.options],
  );

  if (!editor) return <MissingTaskDraft />;

  return (
    <ThreadSettingsPickerScreen
      environmentId={editor.environmentId}
      projectId={projectId}
      providerGroups={providerGroups}
      selectedModel={selectedModel}
      prompt={editor.draft.prompt}
      onPromptChange={(prompt) =>
        setEditor((current) =>
          current ? { ...current, draft: { ...current.draft, prompt } } : current,
        )
      }
      onSelectModel={(option) =>
        setEditor((current) =>
          current
            ? {
                ...current,
                draft: {
                  ...current.draft,
                  modelSelection: option.selection,
                  modelSelectionIsExplicit: true,
                },
              }
            : current,
        )
      }
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) =>
        setEditor((current) =>
          current?.draft.modelSelection
            ? {
                ...current,
                draft: {
                  ...current.draft,
                  modelSelection: { ...current.draft.modelSelection, options },
                  modelSelectionIsExplicit: true,
                },
              }
            : current,
        )
      }
      runtimeMode={editor.draft.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) =>
        setEditor((current) =>
          current
            ? {
                ...current,
                draft: { ...current.draft, runtimeMode },
              }
            : current,
        )
      }
      onClose={() => navigation.goBack()}
    />
  );
}

export function ScheduledTaskRepositoriesPickerRouteScreen() {
  const { editor, setEditor } = useScheduledTaskEditor();
  const projects = useProjects();
  const project =
    projects.find(
      (entry) =>
        entry.environmentId === editor?.environmentId && entry.id === editor.draft.projectId,
    ) ?? null;
  const choice = useScheduledTaskRepositories(project, editor?.draft.repositories ?? null);

  if (!editor) return <MissingTaskDraft />;

  return (
    <SettingsScreen title="Repositories">
      <SettingsSection title="Each starts from its default branch">
        {choice?.error ? (
          <Pressable
            accessibilityRole="button"
            onPress={choice.retry}
            className="min-h-14 justify-center gap-1 px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="text-foreground">
              Couldn't load repositories
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {choice.error} Tap to retry.
            </Text>
          </Pressable>
        ) : null}
        {choice && !choice.loading && !choice.error && choice.options.length === 0 ? (
          <Text textRole="body" className="px-4 py-3 text-foreground-muted">
            This folder holds no repositories. Run the task in the project checkout or a specific
            checkout instead.
          </Text>
        ) : null}
        {choice?.options.map(({ path, label }, index) => {
          const selected = choice.selected.includes(path);
          const atLimit = !selected && choice.selected.length >= REPOSITORY_LIMIT;
          return (
            <Pressable
              key={path}
              accessibilityRole="checkbox"
              accessibilityLabel={label}
              accessibilityState={{ checked: selected, disabled: atLimit }}
              disabled={atLimit}
              onPress={() => {
                void Haptics.selectionAsync();
                const repositories = selected
                  ? choice.selected.filter((entry) => entry !== path)
                  : [...choice.selected, path];
                setEditor((current) =>
                  current ? { ...current, draft: { ...current.draft, repositories } } : current,
                );
              }}
              className={
                index === 0
                  ? "min-h-14 flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
                  : "min-h-14 flex-row items-center justify-between gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
              }
            >
              <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
                {label}
              </Text>
              {selected ? (
                <SymbolView
                  name="checkmark"
                  size={16}
                  tintColorClassName="accent-foreground"
                  type="monochrome"
                />
              ) : null}
            </Pressable>
          );
        })}
      </SettingsSection>
    </SettingsScreen>
  );
}

export function ScheduledTaskBranchPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, setEditor } = useScheduledTaskEditor();
  const projects = useProjects();
  const project =
    projects.find(
      (entry) =>
        entry.environmentId === editor?.environmentId && entry.id === editor.draft.projectId,
    ) ?? null;
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const branches = usePaginatedBranches({
    environmentId: editor?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
    query: debouncedQuery,
  });
  const visibleBranches = branches.refs.filter(
    (branch) => !branch.isRemote && branch.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  if (!editor) return <MissingTaskDraft />;

  return (
    <BranchPickerScreen
      title="Base branch"
      project={project}
      branches={visibleBranches}
      selectedBranchName={editor.draft.baseRef}
      query={query}
      onQueryChange={setQuery}
      loading={
        query.trim() !== debouncedQuery.trim() || (branches.isPending && branches.data === null)
      }
      error={project ? branches.error : "This project is no longer available."}
      refreshing={branches.isFetchingNextPage}
      hasMore={branches.data?.nextCursor != null}
      onRefresh={branches.refresh}
      onLoadMore={branches.loadNext}
      onSelect={(branch) => {
        void Haptics.selectionAsync();
        setEditor((current) =>
          current ? { ...current, draft: { ...current.draft, baseRef: branch.name } } : current,
        );
        navigation.goBack();
      }}
      worktree={{
        startFromOrigin: editor.draft.startFromOrigin,
        onChangeStartFromOrigin: (startFromOrigin) =>
          setEditor((current) =>
            current
              ? {
                  ...current,
                  draft: { ...current.draft, startFromOrigin },
                }
              : current,
          ),
      }}
    />
  );
}

const THREAD_SEARCH_PLACEHOLDER = "Search threads, including older ones";

export function ScheduledTaskThreadPickerRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { editor, setEditor } = useScheduledTaskEditor();
  const environmentId = editor?.environmentId ?? null;
  const projectId = editor?.draft.projectId ?? null;
  const threadId = editor?.draft.threadId ?? null;
  const currentLabel = useScheduledTaskDestinationLabel(environmentId, threadId);
  const shells = useVisibleThreadShells();
  const [query, setQuery] = useState("");
  const search = {
    value: query,
    onChangeText: setQuery,
    placeholder: THREAD_SEARCH_PLACEHOLDER,
    accessibilityLabel: "Search threads",
    clearAccessibilityLabel: "Clear thread search",
    mode: "inline" as const,
    compactToolbar: true,
  };
  const searchToolbarInset = useSearchToolbarInset(search);
  // Mounts older settled threads matching the query, which shells may leave out.
  useThreadSearch(
    environmentId !== null && projectId !== null ? [environmentId] : [],
    query,
    projectId === null ? { titlesOnly: true } : { titlesOnly: true, projectIds: [projectId] },
  );

  if (!editor) return <MissingTaskDraft />;

  const needle = query.trim().toLocaleLowerCase();
  const rows = [
    ...(needle ? [] : [{ key: "new-thread", title: NEW_THREAD_DESTINATION_LABEL, thread: null }]),
    ...(threadId !== null && currentLabel.toLocaleLowerCase().includes(needle)
      ? [{ key: threadId, title: currentLabel, thread: null }]
      : []),
    ...shells
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.projectId === projectId &&
          thread.id !== threadId &&
          thread.archivedAt === null &&
          isListedThreadLineage(thread.lineage) &&
          thread.title.toLocaleLowerCase().includes(needle),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        key: thread.id,
        title: thread.title.trim() || "Untitled thread",
        thread,
      })),
  ];
  const selectedKey = threadId ?? (editor.draft.threadMode === "new_thread" ? "new-thread" : null);

  return (
    <SettingsScreen title="Destination" search={search}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: searchToolbarInset
            ? searchToolbarInset + 16
            : Math.max(insets.bottom, 16) + 16,
        }}
        ListEmptyComponent={
          <Text className="p-5 text-center text-sm text-foreground-muted">No matching threads</Text>
        }
        renderItem={({ item, index }) => (
          <SelectionRow
            title={item.title}
            selected={item.key === selectedKey}
            isFirst={index === 0}
            isLast={index === rows.length - 1}
            onPress={() => {
              void Haptics.selectionAsync();
              if (item.key !== selectedKey) {
                setEditor((current) =>
                  current
                    ? {
                        ...current,
                        draft: item.thread
                          ? moveDraftToThread(current.draft, item.thread)
                          : { ...unbindDraftFromThread(current.draft), threadMode: "new_thread" },
                      }
                    : current,
                );
              }
              navigation.goBack();
            }}
          />
        )}
      />
    </SettingsScreen>
  );
}
