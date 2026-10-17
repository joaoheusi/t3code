import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  hasRepositorySet,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  describeQuickActionGit,
  describeQuickActionGitConfirmations,
  planQuickActionGitBatch,
  quickActionGitRowTitle,
  quickActionGitTargets,
  resolveQuickActionGit,
  sameQuickActionGit,
  summarizeQuickActionGit,
  type GitQuickAction,
  type QuickActionGitRepository,
} from "@t3tools/client-runtime/quickActionGit";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { PickerCaption, PickerRow, PickerSurface } from "../../components/PickerList";
import { uuidv4 } from "../../lib/uuid";
import { useProject, useThreadShell } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { showGitActionResult } from "../../state/use-vcs-action-state";
import { vcsActionManager, vcsEnvironment } from "../../state/vcs";
import { ForkScreenHeader } from "./ForkScreenHeader";
import type { QuickActionsTarget } from "./MobileQuickActions";

/** The Git row's repositories and summary, which the list reads to order the row. */
export function useQuickActionGitSummary(target: QuickActionsTarget) {
  const thread = useThreadShell(
    target.threadId ? { environmentId: target.environmentId, threadId: target.threadId } : null,
  );
  const project = useProject({ environmentId: target.environmentId, projectId: target.projectId });
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const targets = useMemo(
    () => quickActionGitTargets(thread?.workspace, cwd),
    [thread?.workspace, cwd],
  );
  const canWrite = useEnvironmentScope(target.environmentId, AuthSourceControlWriteScope);
  const repositoriesAtom = useMemo(
    () =>
      Atom.make((get) =>
        targets.map((repository) => {
          const status = repository.unavailable
            ? null
            : Option.getOrNull(
                AsyncResult.value(
                  get(
                    vcsEnvironment.status({
                      environmentId: target.environmentId,
                      input: { cwd: repository.cwd },
                    }),
                  ),
                ),
              );
          const busy = get(
            vcsActionManager.stateAtom({
              environmentId: target.environmentId,
              cwd: repository.cwd,
            }),
          ).isRunning;
          return { ...repository, status, busy, action: resolveQuickActionGit(status, busy) };
        }),
      ),
    [target.environmentId, targets],
  );
  const repositories = useAtomValue(repositoriesAtom);
  const summary = summarizeQuickActionGit(repositories);
  return { thread, repositories, summary, canWrite };
}

/** A repository's fresh status and the action it will run, checked against what was shown. */
interface PreparedGitAction {
  readonly status: VcsStatusResult;
  readonly action: GitQuickAction;
}

type BatchEntry = PreparedGitAction & {
  readonly repository: QuickActionGitRepository;
  readonly label: string;
  readonly cwd: string;
};

/** The native surface uses the same repository plan as the desktop palette. */
export function MobileGitQuickAction(props: {
  target: QuickActionsTarget;
  query: string;
  isLast?: boolean;
  onClose: () => void;
  choosing: boolean;
  onChoosingChange: (choosing: boolean) => void;
}) {
  const { target } = props;
  const registry = useContext(RegistryContext);
  const { thread, repositories, summary, canWrite } = useQuickActionGitSummary(target);
  const loadStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const preparing = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [selectedCwds, setSelectedCwds] = useState<readonly string[]>([]);
  const busy = busyCwd !== null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const assertWrite = () => {
    if (!readEnvironmentScope(target.environmentId, AuthSourceControlWriteScope))
      throw new Error("This connection cannot change source control.");
  };

  const prepareRepository = async (
    repository: QuickActionGitRepository,
  ): Promise<PreparedGitAction> => {
    const destination = { environmentId: target.environmentId, cwd: repository.cwd };
    assertWrite();
    const result = await loadStatus({
      environmentId: target.environmentId,
      input: { cwd: repository.cwd },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    assertWrite();
    const action = resolveQuickActionGit(
      result.value,
      registry.get(vcsActionManager.stateAtom(destination)).isRunning,
    );
    if (action.disabled) throw new Error(action.hint ?? "This action is unavailable.");
    if (
      !sameQuickActionGit(
        repository.action,
        action,
        repository.status?.refName ?? null,
        result.value.refName,
      )
    )
      throw new Error("Repository status changed. Choose the updated action.");
    return { status: result.value, action };
  };

  /** One repository's write; the caller owns result reporting and busy state. */
  const performRepository = async (
    repository: QuickActionGitRepository,
    prepared: PreparedGitAction,
    featureBranch: boolean,
  ): Promise<{ readonly title: string; readonly description: string }> => {
    const destination = { environmentId: target.environmentId, cwd: repository.cwd };
    assertWrite();
    if (
      featureBranch &&
      thread &&
      !readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    )
      throw new Error("This connection cannot change the thread's branch.");
    try {
      if (prepared.action.kind === "run_pull") {
        const result = await vcsActionManager.track(
          registry,
          destination,
          { operation: "pull", label: "Pulling latest changes…" },
          () => pull({ environmentId: target.environmentId, input: { cwd: repository.cwd } }),
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return {
          title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
          description: repository.label,
        };
      }
      const kind = prepared.action.action;
      if (!kind) throw new Error("This action is unavailable.");
      const result = await runAtomCommand(
        registry,
        vcsActionManager.runStackedAction(destination),
        {
          actionId: uuidv4(),
          action: kind,
          featureBranch,
          ...(thread ? { threadId: thread.id } : {}),
          projectId: target.projectId,
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const branch = result.value.branch;
      if (
        thread &&
        branch.status === "created" &&
        branch.name &&
        !hasRepositorySet(thread.workspace) &&
        readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
      ) {
        const updated = await update({
          environmentId: target.environmentId,
          input: { threadId: thread.id, branch: branch.name },
        });
        if (updated._tag === "Failure") throw squashAtomCommandFailure(updated);
      }
      return {
        title: result.value.toast.title,
        description: result.value.toast.description ?? repository.label,
      };
    } finally {
      registry.refresh(
        vcsEnvironment.status({
          environmentId: target.environmentId,
          input: { cwd: repository.cwd },
        }),
      );
    }
  };

  /**
   * Checks every selected repository before any write, then runs each one's own
   * action in turn. Default-branch writes share one confirmation.
   */
  const runRepositories = async (selected: readonly QuickActionGitRepository[]) => {
    if (preparing.current || selected.length === 0) return;
    preparing.current = true;
    setError(null);
    const finish = () => {
      preparing.current = false;
      if (mounted.current) setBusyCwd(null);
    };
    const prepareAll = async (): Promise<BatchEntry[]> => {
      const entries: BatchEntry[] = [];
      for (const repository of selected) {
        if (mounted.current) setBusyCwd(repository.cwd);
        const prepared = await prepareRepository(repository);
        entries.push({ repository, label: repository.label, cwd: repository.cwd, ...prepared });
      }
      return entries;
    };
    let confirming = false;
    try {
      const entries = await prepareAll();
      if (!mounted.current) return;
      const plan = planQuickActionGitBatch(entries);
      if (plan.kind === "blocked") {
        setError(plan.reason);
        return;
      }
      if (plan.kind === "publish") {
        Alert.alert(
          "Publish repository",
          "Add a remote or publish this repository from Projects before pushing.",
        );
        return;
      }
      const confirmedCwds = new Set(plan.confirmations.map((entry) => entry.cwd));
      let started = false;
      const executeAll = async (featureBranch: boolean, recheck: boolean) => {
        if (started) return;
        started = true;
        try {
          let list = entries;
          if (recheck) {
            list = await prepareAll();
            if (!mounted.current) return;
            const replanned = planQuickActionGitBatch(list);
            if (
              replanned.kind !== "run" ||
              replanned.confirmations.length !== confirmedCwds.size ||
              replanned.confirmations.some((entry) => !confirmedCwds.has(entry.cwd))
            ) {
              throw new Error("Repository status changed. Choose the updated action.");
            }
          }
          const succeeded: string[] = [];
          const succeededCwds: string[] = [];
          const failures: string[] = [];
          let single: { title: string; description: string } | null = null;
          for (const entry of list) {
            if (!mounted.current) return;
            setBusyCwd(entry.cwd);
            try {
              const result = await performRepository(
                entry.repository,
                entry,
                featureBranch && confirmedCwds.has(entry.cwd),
              );
              single = result;
              succeededCwds.push(entry.cwd);
              succeeded.push(`${entry.label} · ${result.title}`);
            } catch (cause) {
              failures.push(
                list.length === 1
                  ? cause instanceof Error
                    ? cause.message
                    : "Git action failed."
                  : `${entry.label}: ${cause instanceof Error ? cause.message : "Git action failed."}`,
              );
            }
          }
          if (!mounted.current) return;
          if (failures.length === 0 && single) {
            showGitActionResult(
              list.length === 1
                ? { type: "success", title: single.title, description: single.description }
                : {
                    type: "success",
                    title: `Synced ${list.length} repositories`,
                    description: succeeded.join("\n"),
                  },
            );
            props.onClose();
          } else if (list.length === 1) {
            setError(failures[0] ?? "Git action failed.");
          } else {
            showGitActionResult({
              type: "error",
              title: `${succeeded.length} of ${list.length} repositories synced`,
              description: [...succeeded, ...failures].join("\n"),
            });
            // Succeeded repositories are done; keep only the failed ones selected for a retry.
            setSelectedCwds((previous) => previous.filter((cwd) => !succeededCwds.includes(cwd)));
            setError(failures.join("\n"));
          }
        } catch (cause) {
          if (mounted.current)
            setError(cause instanceof Error ? cause.message : "Git action failed.");
        } finally {
          finish();
        }
      };
      if (plan.confirmations.length === 0) {
        await executeAll(false, false);
        return;
      }
      confirming = true;
      const only = plan.confirmations.length === 1 ? plan.confirmations[0]! : null;
      const others = entries.length - plan.confirmations.length;
      // The prompt stays on this screen, so the exact repositories are retained through confirmation.
      Alert.alert(
        only ? `${only.action.label} on ${only.status.refName!}?` : "Write to default branches?",
        only && entries.length === 1
          ? `${only.label}\n${describeQuickActionGit(only.repository)}`
          : [
              describeQuickActionGitConfirmations(plan.confirmations),
              ...(others > 0 ? [`Plus ${others} other repositories`] : []),
            ].join("\n"),
        [
          { text: "Cancel", style: "cancel", onPress: finish },
          ...(thread && !readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
            ? []
            : [
                {
                  text: "Create feature branch",
                  onPress: () => {
                    void executeAll(true, true);
                  },
                },
              ]),
          {
            text: only ? `Continue on ${only.status.refName!}` : "Continue on default branches",
            onPress: () => {
              void executeAll(false, true);
            },
          },
        ],
        { cancelable: false },
      );
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Git action failed.");
    } finally {
      if (!confirming) finish();
    }
  };

  if (props.choosing) {
    // A selected repository can become unusable while this screen stays open, such as
    // after it synced in a partly failed batch. Only runnable ones count as selected.
    const selectable = repositories.filter(
      (repository) =>
        selectedCwds.includes(repository.cwd) &&
        !repository.unavailable &&
        !repository.action.disabled,
    );
    const selectableCwds = new Set(selectable.map((repository) => repository.cwd));
    return (
      <View className="flex-1 bg-sheet">
        <ForkScreenHeader
          title="Sync repositories"
          cancel={{ label: "Back", onPress: () => props.onChoosingChange(false) }}
          action={{
            accessibilityLabel: "Sync selected",
            label: "Sync",
            icon: "checkmark",
            disabled: busy || selectable.length === 0,
            onPress: () => void runRepositories(selectable),
          }}
        />
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, gap: 12 }}
        >
          <PickerCaption>
            Choose one or more repositories. Each row shows its next action.
          </PickerCaption>
          <PickerSurface>
            {repositories.map((repository, index) => (
              <PickerRow
                multiline
                key={repository.cwd}
                title={quickActionGitRowTitle(repository)}
                subtitle={
                  !canWrite
                    ? "This connection cannot change source control."
                    : describeQuickActionGit(repository)
                }
                symbol="arrow.triangle.branch"
                leading={
                  repository.busy || busyCwd === repository.cwd ? (
                    <ActivityIndicator
                      size="small"
                      colorClassName="accent-icon-muted"
                      accessibilityLabel="Git action in progress"
                    />
                  ) : undefined
                }
                selected={selectableCwds.has(repository.cwd)}
                accessibilityRole="checkbox"
                disabled={
                  busy || !canWrite || !!repository.unavailable || repository.action.disabled
                }
                isLast={index === repositories.length - 1}
                onPress={() =>
                  setSelectedCwds((previous) =>
                    previous.includes(repository.cwd)
                      ? previous.filter((cwd) => cwd !== repository.cwd)
                      : [...previous, repository.cwd],
                  )
                }
              />
            ))}
          </PickerSurface>
          {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
        </ScrollView>
      </View>
    );
  }
  if (
    props.query.trim() &&
    ![
      summary.label,
      "git commit push pull pr sync",
      ...repositories.map((repository) => repository.label),
    ]
      .join(" ")
      .toLowerCase()
      .includes(props.query.trim().toLowerCase())
  )
    return null;
  return (
    <>
      <PickerRow
        multiline
        title={summary.label}
        subtitle={!canWrite ? "This connection cannot change source control." : summary.description}
        symbol="bolt.circle"
        leading={
          busy || repositories.some((repository) => repository.busy) ? (
            <ActivityIndicator
              size="small"
              colorClassName="accent-icon-muted"
              accessibilityLabel="Git action in progress"
            />
          ) : undefined
        }
        isLast={props.isLast}
        disabled={busy || !canWrite || summary.disabled}
        onPress={() => {
          if (repositories.length === 1) void runRepositories([repositories[0]!]);
          else props.onChoosingChange(true);
        }}
      />
      {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
    </>
  );
}
