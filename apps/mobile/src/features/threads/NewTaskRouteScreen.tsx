import { MaterialListRow } from "../../components/MaterialListRow";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { filterProjectScopes, getProjectScopeSelectionTarget } from "./new-task-project-selection";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
};

function deriveProjectEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment before creating a task.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects from the saved environment.",
      loading: true,
    };
  }

  return {
    title: "No projects found",
    detail: "The connected environment did not report any projects.",
    loading: false,
  };
}

function NewTaskHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly canAddProject: boolean;
  readonly selection: {
    readonly available: boolean;
    readonly active: boolean;
    readonly onToggle: () => void;
  };
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  return (
    <ScreenHeader
      title={props.title}
      subtitle={props.subtitle ?? undefined}
      sidebar={false}
      backInSplitView={{
        accessibilityLabel: "Go back",
        icon: "chevron.left",
      }}
      options={{ headerBackVisible: !layout.usesSplitView }}
      hideBottomBorder
      onBack={() => navigation.goBack()}
      actions={[
        ...(props.selection.available
          ? [
              {
                accessibilityLabel: props.selection.active
                  ? "Stop selecting projects"
                  : "Select several projects",
                icon: props.selection.active ? ("xmark" as const) : ("checkmark.circle" as const),
                onPress: props.selection.onToggle,
              },
            ]
          : []),
        ...(props.canAddProject && !props.selection.active
          ? [
              {
                accessibilityLabel: "Add project",
                icon: "plus" as const,
                onPress: () => navigation.dispatch(StackActions.push("AddProject")),
              },
            ]
          : []),
      ]}
      search={{
        value: props.searchText,
        onChangeText: props.onSearchTextChange,
        placeholder: "Search projects",
      }}
    />
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a project for what you shared"
      : incomingShare.attachments.length === 1
        ? `Choose a project for the ${incomingShare.attachments[0]?.type === "image" ? "image" : "file"} you shared`
        : `Choose a project for the ${incomingShare.attachments.length} ${incomingShare.attachments.every((attachment) => attachment.type === "image") ? "images" : "files"} you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose project";
  const projectEmptyState = deriveProjectEmptyState(catalogState);
  const serverConfigs = useServerConfigs();
  // Scratch projects are reached through the No project row, never as rows
  // of their own.
  const listScopes = projectScopes.filter(
    (scope) =>
      !scope.projects.every((project) =>
        isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      ),
  );
  const visibleScopes = filterProjectScopes(listScopes, searchText);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, {
    reportFailure: false,
  });
  // Threads without a project need a connected environment that offers them.
  // The row starts on the selected environment when it has one, otherwise the
  // first that does; the draft page's machine picker moves it from there.
  const scratchEnvironments = connectedEnvironments.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        serverConfigs.get(environment.environmentId),
      ) !== null,
  );
  const scratchEnvironment =
    scratchEnvironments.find(
      (environment) => environment.environmentId === selectedEnvironmentId,
    ) ??
    scratchEnvironments[0] ??
    null;
  const canStartScratch = scratchEnvironment !== null && reservedDestinationProject === null;
  const scratchStartInFlightRef = useRef(false);
  // Select mode starts one task across several projects: the first pick is the task's
  // project and the rest become its repositories.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlyArray<EnvironmentProject>>([]);
  const changingDraftProject = (() => {
    const state = navigation.getState();
    return state?.routes[state.index - 1]?.name === "NewTaskDraft";
  })();
  const canSelectSeveral =
    !incomingShare &&
    !changingDraftProject &&
    listScopes.some(
      (scope) =>
        (serverConfigs.get(scope.representative.environmentId)?.environment.capabilities
          .forkMultiRepoVersion ?? 0) >= 2,
    );
  const pickedEnvironmentId = picked[0]?.environmentId ?? null;
  const togglePicked = (project: EnvironmentProject) =>
    setPicked((current) =>
      current.some(
        (entry) => entry.environmentId === project.environmentId && entry.id === project.id,
      )
        ? current.filter(
            (entry) => !(entry.environmentId === project.environmentId && entry.id === project.id),
          )
        : [...current, project],
    );
  const startPicked = () => {
    const [primary, ...rest] = picked;
    if (!primary) return;
    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: primary.environmentId,
        projectId: primary.id,
        title: primary.title,
        repositoryPaths: rest.map((project) => project.workspaceRoot),
      }),
    );
    setSelecting(false);
    setPicked([]);
  };

  async function selectProject(project: EnvironmentProject): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Alert.alert(
          "Could not change project",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    const state = navigation.getState();
    const previousRoute = state?.routes[state.index - 1];
    if (previousRoute?.name === "NewTaskDraft") {
      setProject(project);
      navigation.goBack();
      return;
    }

    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        incomingShareId: incomingShare?.id,
      }),
    );
  }

  async function startScratch(): Promise<void> {
    if (!scratchEnvironment || scratchStartInFlightRef.current) return;
    const environmentId = scratchEnvironment.environmentId;
    scratchStartInFlightRef.current = true;
    try {
      const result = await openScratch({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not start without a project",
            error instanceof Error
              ? error.message
              : "The folder for threads without a project could not be created.",
          );
        }
        return;
      }
      await selectProject(result.value);
    } finally {
      scratchStartInFlightRef.current = false;
    }
  }

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Returning from the reserved draft is a fresh resume attempt. Keeping
      // this latch set would leave every project row disabled with no route.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: reservedDestinationProject.environmentId,
        projectId: reservedDestinationProject.id,
        title: reservedDestinationProject.title,
        incomingShareId: incomingShare.id,
      }),
    );
  }, [incomingShare, isFocused, navigation, reservedDestinationProject]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title={
          selecting
            ? picked.length > 0
              ? `${picked.length} selected`
              : "Select projects"
            : screenTitle
        }
        subtitle={selecting ? "The first one is the task's project" : incomingShareSubtitle}
        canAddProject={catalogState.hasReadyEnvironment}
        selection={{
          available: canSelectSeveral,
          active: selecting,
          onToggle: () => {
            setSelecting((value) => !value);
            setPicked([]);
          },
        }}
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18 + (selecting ? 64 : 0),
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {canStartScratch && listScopes.length > 0 && !selecting ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <MaterialListRow
                  className="bg-grouped-card"
                  title="No project"
                  subtitle="Start a task without a project"
                  onPress={() => void startScratch()}
                  leading={
                    <SymbolView
                      name="text.bubble"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="No project"
                  onPress={() => void startScratch()}
                  className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="text.bubble"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">No project</Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      Start a task without a project
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
          {listScopes.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-grouped-card",
              )}
            >
              {projectEmptyState.loading ? (
                <ActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <MaterialButton
                    label={catalogState.hasReadyEnvironment ? "Add new project" : "Add environment"}
                    tone="primary"
                    onPress={() =>
                      catalogState.hasReadyEnvironment
                        ? navigation.dispatch(StackActions.push("AddProject"))
                        : navigation.navigate("ConnectionsNew")
                    }
                  />
                  {canStartScratch ? (
                    <MaterialButton
                      label="Start without a project"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
                  ) : null}
                </>
              ) : !catalogState.hasReadyEnvironment ? (
                <Pressable
                  className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                  onPress={() => navigation.navigate("ConnectionsNew")}
                >
                  <Text className="text-sm font-t3-bold text-primary-foreground">
                    Add environment
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                    onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                  >
                    <Text className="text-sm font-t3-bold text-primary-foreground">
                      Add new project
                    </Text>
                  </Pressable>
                  {canStartScratch ? (
                    <Pressable
                      className="rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
                      onPress={() => void startScratch()}
                    >
                      <Text className="text-sm font-t3-bold text-foreground">
                        Start without a project
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                No matching projects
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                Try a different project name or workspace path.
              </Text>
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-grouped-card"
                  : "overflow-hidden rounded-[24px] bg-grouped-card"
              }
            >
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const selectionTarget = getProjectScopeSelectionTarget(
                  scope,
                  pickedEnvironmentId ?? selectedEnvironmentId,
                );
                const pickIndex = picked.findIndex(
                  (entry) =>
                    entry.environmentId === selectionTarget.environmentId &&
                    entry.id === selectionTarget.id,
                );
                // Repositories in one task must live on the same machine.
                const pickable =
                  !selecting ||
                  pickedEnvironmentId === null ||
                  selectionTarget.environmentId === pickedEnvironmentId;
                const onRowPress = () =>
                  selecting ? togglePicked(selectionTarget) : void selectProject(selectionTarget);
                const selectionMark = selecting ? (
                  <SymbolView
                    name={pickIndex >= 0 ? "checkmark.circle" : "circle"}
                    size={Platform.OS === "android" ? 22 : 20}
                    tintColorClassName={pickIndex >= 0 ? "accent-focus" : "accent-icon-muted"}
                    type="monochrome"
                  />
                ) : null;
                if (Platform.OS === "android") {
                  return (
                    <MaterialListRow
                      className="bg-grouped-card"
                      key={scope.key}
                      title={scope.title}
                      subtitle={
                        hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : selectionTarget.workspaceRoot
                      }
                      disabled={reservedDestinationProject !== null || !pickable}
                      onPress={onRowPress}
                      trailing={selectionMark}
                      leading={
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={24}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      }
                    />
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      accessibilityState={selecting ? { checked: pickIndex >= 0 } : undefined}
                      disabled={reservedDestinationProject !== null || !pickable}
                      onPress={onRowPress}
                      className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5"
                      style={{ opacity: pickable ? 1 : 0.45 }}
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={20}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {hasMultipleProjects
                            ? `${scope.projects.length} workspaces`
                            : selectionTarget.workspaceRoot}
                        </Text>
                      </View>
                      {selectionMark ?? (
                        <SymbolView
                          name="chevron.right"
                          size={14}
                          tintColorClassName="accent-chevron"
                          type="monochrome"
                        />
                      )}
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </ScrollView>
      </MaterialScreenContent>
      {selecting ? (
        <View
          className="absolute inset-x-0 bottom-0 px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) + 4 }}
        >
          <Pressable
            accessibilityRole="button"
            disabled={picked.length === 0}
            onPress={startPicked}
            className={cn(
              "h-12 items-center justify-center rounded-full active:opacity-80",
              picked.length === 0 ? "bg-subtle-strong" : "bg-primary",
            )}
          >
            <Text
              className={cn(
                "text-base font-t3-bold",
                picked.length === 0 ? "text-foreground-muted" : "text-primary-foreground",
              )}
            >
              {picked.length === 0
                ? "Choose projects"
                : `Start with ${picked.length} ${picked.length === 1 ? "project" : "projects"}`}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
