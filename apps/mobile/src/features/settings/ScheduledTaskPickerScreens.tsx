import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import { useScheduledTaskRepositories } from "./useScheduledTaskRepositories";

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
        {choice?.options.map(({ path, label }, index) => {
          const selected = choice.selected.includes(path);
          return (
            <Pressable
              key={path}
              accessibilityRole="checkbox"
              accessibilityLabel={label}
              accessibilityState={{ checked: selected }}
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
                  ? "min-h-14 flex-row items-center justify-between gap-3 px-4 py-3 active:opacity-70"
                  : "min-h-14 flex-row items-center justify-between gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
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
