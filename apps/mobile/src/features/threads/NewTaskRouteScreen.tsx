import { isDraftThreadRoute } from "./thread-route-state";
import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { AppBar } from "../../components/ui/AppBar";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";

import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  resolveNewTaskScratchOption,
} from "./new-task-project-selection";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
  readonly prompt?: string | string[];
  readonly repo?: string | string[];
  readonly pr?: string | string[];
  readonly provider?: string | string[];
  readonly model?: string | string[];
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
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
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
    readonly count: number;
    readonly onToggle: () => void;
    readonly onConfirm: () => void;
  };
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation();
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.getParent()?.goBack();
  };
  return (
    <>
      <AppBar
        title={props.title}
        subtitle={props.subtitle ?? undefined}
        sidebar={false}
        options={{ headerBackVisible: true }}
        hideBottomBorder
        onBack={goBack}
        actions={[
          // The confirm lives in the header: iOS pins the search bar to the bottom of the sheet.
          ...(props.selection.active
            ? [
                {
                  accessibilityLabel:
                    props.selection.count === 0
                      ? "Choose projects to start"
                      : `Start with ${props.selection.count} ${props.selection.count === 1 ? "project" : "projects"}`,
                  icon: "checkmark" as const,
                  disabled: props.selection.count === 0,
                  onPress: props.selection.onConfirm,
                },
              ]
            : []),
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
    </>
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
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
  const listScopes = pickableProjectGroups(projectScopes).filter(
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
  const connectedEnvironmentIds = new Set(
    connectedEnvironments
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  const openScratch = useAtomCommand(projectEnvironment.openScratch, {
    reportFailure: false,
  });
  const scratchOption =
    reservedDestinationProject === null
      ? resolveNewTaskScratchOption({
          environments: connectedEnvironments,
          serverConfigs,
          selectedEnvironmentId,
        })
      : null;
  const canStartScratch = scratchOption?.ready === true;
  const scratchStartInFlightRef = useRef(false);
  // Select mode starts one task across several projects: the first pick is the task's
  // project and the rest become its repositories.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlyArray<EnvironmentProject>>([]);
  const projectPickerRoot = navigation.getState()?.routeNames.includes("NewTaskProject")
    ? navigation
    : navigation.getParent();
  const changingDraftProject = (() => {
    const state = projectPickerRoot?.getState();
    return state ? isDraftThreadRoute(state.routes[state.index - 1]) : false;
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
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: String(primary.environmentId),
          projectId: String(primary.id),
          title: primary.title,
          repositoryPaths: rest.map((project) => project.workspaceRoot),
        },
      },
    });
    setSelecting(false);
    setPicked([]);
  };

  async function selectProject(project: EnvironmentProject): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Dialog.alert(
          "Could not change project",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    const root = navigation.getState()?.routeNames.includes("NewTaskProject")
      ? navigation
      : navigation.getParent();
    const rootState = root?.getState();
    const threadRoute = rootState?.routes[rootState.index - 1];
    if (isDraftThreadRoute(threadRoute)) {
      setProject(project);
      root?.goBack();
      return;
    }
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          incomingShareId: incomingShare?.id,
        },
      },
    });
  }

  async function startScratch(): Promise<void> {
    if (!canStartScratch || !scratchOption || scratchStartInFlightRef.current) return;
    const environmentId = scratchOption.environmentId;
    scratchStartInFlightRef.current = true;
    const result = await openScratch({ environmentId, input: {} });
    if (result._tag === "Failure") {
      scratchStartInFlightRef.current = false;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Could not start without a project",
          error instanceof Error
            ? error.message
            : "The folder for threads without a project could not be created.",
        );
      }
      return;
    }
    // selectProject handles its own failures, so this never throws.
    await selectProject(result.value);
    scratchStartInFlightRef.current = false;
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- navigates to the incoming share's reserved destination draft once its project loads and the screen is focused
  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Reset on return so reserved-draft resume can retry without leaving project rows disabled.
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
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          environmentId: reservedDestinationProject.environmentId,
          projectId: reservedDestinationProject.id,
          title: reservedDestinationProject.title,
          incomingShareId: incomingShare.id,
        },
      },
    });
  }, [incomingShare, isFocused, reservedDestinationProject, selectDetail]);

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
        subtitle={selecting ? null : incomingShareSubtitle}
        canAddProject={catalogState.hasReadyEnvironment}
        selection={{
          available: canSelectSeveral,
          active: selecting,
          count: picked.length,
          onConfirm: startPicked,
          onToggle: () => {
            setSelecting((value) => !value);
            setPicked([]);
          },
        }}
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <ScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {scratchOption !== null && listScopes.length > 0 && !selecting ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-grouped-card">
                <NavigationRow
                  className="bg-grouped-card"
                  title="No project"
                  subtitle="Start a task without a project"
                  disabled={!canStartScratch}
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
                  disabled={!canStartScratch}
                  onPress={() => void startScratch()}
                  className={cn(
                    "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
                    !canStartScratch && "opacity-45",
                  )}
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
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <Button
                    label={catalogState.hasReadyEnvironment ? "Add new project" : "Add environment"}
                    tone="primary"
                    onPress={() =>
                      catalogState.hasReadyEnvironment
                        ? navigation.dispatch(StackActions.push("AddProject"))
                        : navigation.navigate("ConnectionsNew")
                    }
                  />
                  {canStartScratch ? (
                    <Button
                      label="Start without a project"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
                  ) : null}
                </>
              ) : !catalogState.hasReadyEnvironment ? (
                <View className="mt-1">
                  <Button
                    label="Add environment"
                    tone="primary"
                    onPress={() => navigation.navigate("ConnectionsNew")}
                  />
                </View>
              ) : (
                <>
                  <View className="mt-1">
                    <Button
                      label="Add new project"
                      tone="primary"
                      onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                    />
                  </View>
                  {canStartScratch ? (
                    <Button
                      label="Start without a project"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
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
                  connectedEnvironmentIds,
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
                    <NavigationRow
                      className="bg-grouped-card"
                      key={scope.key}
                      title={scope.title}
                      subtitle={
                        hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : selectionTarget.workspaceRoot
                      }
                      subtitleNumberOfLines={1}
                      subtitleEllipsizeMode="middle"
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
      </ScreenContent>
    </View>
  );
}
