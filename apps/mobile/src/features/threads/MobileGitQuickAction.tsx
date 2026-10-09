import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  hasRepositorySet,
} from "@t3tools/contracts";
import {
  describeQuickActionGit,
  quickActionGitTargets,
  resolveQuickActionGit,
  sameQuickActionGit,
  summarizeQuickActionGit,
  type QuickActionGitRepository,
} from "@t3tools/client-runtime/quickActionGit";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { requiresDefaultBranchConfirmation } from "@t3tools/client-runtime/state/vcs";
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

/** The native surface uses the same repository plan as the desktop palette. */
export function MobileGitQuickAction(props: {
  target: QuickActionsTarget;
  query: string;
  onClose: () => void;
  choosing: boolean;
  onChoosingChange: (choosing: boolean) => void;
}) {
  const { target } = props;
  const registry = useContext(RegistryContext);
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
          return { ...repository, status, action: resolveQuickActionGit(status, busy) };
        }),
      ),
    [target.environmentId, targets],
  );
  const repositories = useAtomValue(repositoriesAtom);
  const summary = summarizeQuickActionGit(repositories);
  const loadStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const update = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const preparing = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (repository: QuickActionGitRepository) => {
    if (preparing.current) return;
    preparing.current = true;
    setBusy(true);
    setError(null);
    const destination = { environmentId: target.environmentId, cwd: repository.cwd };
    const assertWrite = () => {
      if (!readEnvironmentScope(target.environmentId, AuthSourceControlWriteScope))
        throw new Error("This connection cannot change source control.");
    };
    const refresh = async () => {
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
    let confirming = false;
    try {
      const current = await refresh();
      if (!mounted.current) return;
      if (current.action.kind === "open_publish") {
        Alert.alert(
          "Publish repository",
          "Add a remote or publish this repository from Projects before pushing.",
        );
        return;
      }
      let started = false;
      const execute = async (featureBranch: boolean, recheck: boolean) => {
        if (started) return;
        started = true;
        try {
          if (!mounted.current) return;
          if (recheck) await refresh();
          if (!mounted.current) return;
          assertWrite();
          if (
            featureBranch &&
            thread &&
            !readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
          )
            throw new Error("This connection cannot change the thread's branch.");
          setBusy(true);
          if (current.action.kind === "run_pull") {
            const result = await vcsActionManager.track(
              registry,
              destination,
              { operation: "pull", label: "Pulling latest changes…" },
              () => pull({ environmentId: target.environmentId, input: { cwd: repository.cwd } }),
            );
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            showGitActionResult({
              type: "success",
              title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
              description: repository.label,
            });
          } else if (current.action.action) {
            const result = await runAtomCommand(
              registry,
              vcsActionManager.runStackedAction(destination),
              {
                actionId: uuidv4(),
                action: current.action.action,
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
            showGitActionResult({
              type: "success",
              title: result.value.toast.title,
              description: result.value.toast.description ?? repository.label,
            });
          }
          if (mounted.current) props.onClose();
        } catch (cause) {
          if (mounted.current)
            setError(cause instanceof Error ? cause.message : "Git action failed.");
        } finally {
          registry.refresh(
            vcsEnvironment.status({
              environmentId: target.environmentId,
              input: { cwd: repository.cwd },
            }),
          );
          preparing.current = false;
          if (mounted.current) setBusy(false);
        }
      };
      if (
        current.action.action &&
        requiresDefaultBranchConfirmation(current.action.action, current.status.isDefaultRef)
      ) {
        confirming = true;
        const branch = current.status.refName!;
        // The prompt stays on this screen, so the exact repository is retained through confirmation.
        Alert.alert(
          `${current.action.label} on ${branch}?`,
          `${repository.label}\n${describeQuickActionGit(repository)}`,
          [
            {
              text: "Cancel",
              style: "cancel",
              onPress: () => {
                preparing.current = false;
                setBusy(false);
              },
            },
            ...(thread && !readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
              ? []
              : [
                  {
                    text: "Create feature branch",
                    onPress: () => {
                      void execute(true, true);
                    },
                  },
                ]),
            {
              text: `Continue on ${branch}`,
              onPress: () => {
                void execute(false, true);
              },
            },
          ],
          { cancelable: false },
        );
        return;
      }
      await execute(false, false);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Git action failed.");
    } finally {
      if (!confirming) {
        preparing.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };

  if (props.choosing)
    return (
      <View className="flex-1 bg-sheet">
        <ForkScreenHeader
          title="Sync repositories"
          cancel={{ label: "Back", onPress: () => props.onChoosingChange(false) }}
        />
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, gap: 12 }}
        >
          <PickerCaption>Choose a repository. Each row shows its next action.</PickerCaption>
          <PickerSurface>
            {repositories.map((repository, index) => (
              <PickerRow
                multiline
                key={repository.cwd}
                title={`${repository.label} — ${repository.action.label}`}
                subtitle={
                  !canWrite
                    ? "This connection cannot change source control."
                    : describeQuickActionGit(repository)
                }
                symbol="arrow.triangle.branch"
                disabled={
                  busy || !canWrite || !!repository.unavailable || repository.action.disabled
                }
                isLast={index === repositories.length - 1}
                onPress={() => {
                  void run(repository);
                }}
              />
            ))}
          </PickerSurface>
          {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
          {busy ? <PickerCaption>Running Git action…</PickerCaption> : null}
        </ScrollView>
      </View>
    );
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
    <View className="gap-2">
      <PickerSurface>
        <PickerRow
          multiline
          title={summary.label}
          subtitle={
            !canWrite ? "This connection cannot change source control." : summary.description
          }
          symbol="arrow.triangle.branch"
          isLast
          disabled={busy || !canWrite || summary.disabled}
          onPress={() => {
            if (repositories.length === 1) void run(repositories[0]!);
            else props.onChoosingChange(true);
          }}
        />
      </PickerSurface>
      {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
      {busy ? <PickerCaption>Running Git action…</PickerCaption> : null}
    </View>
  );
}
