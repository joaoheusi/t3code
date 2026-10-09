import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  hasRepositorySet,
  type GitStackedAction,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { CloudDownloadIcon, CloudUploadIcon, GitCommitIcon } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { openCommandPalette } from "../commandPaletteBus";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { PublishRepositoryDialog } from "../components/GitActionsControl";
import {
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveThreadBranchMetadataPatch,
  resolveThreadBranchUpdate,
} from "../components/GitActionsControl.logic";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { getChangeRequestTerminology } from "../sourceControlPresentation";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import type { QuickActionScope } from "./quickActionRunner";
import {
  quickActionGitTargets,
  describeQuickActionGit,
  summarizeQuickActionGit,
  resolveQuickActionGit,
  sameQuickActionGit,
} from "@t3tools/client-runtime/quickActionGit";

/** Each repository subscribes to the same live status and operation state as its sidebar. */
export function useQuickActionGit(
  scope: QuickActionScope | null,
  cwd: string | null,
  close: () => void,
) {
  const registry = useContext(RegistryContext);
  const canWrite = useEnvironmentScope(scope?.environmentId ?? null, AuthSourceControlWriteScope);
  const canOperate = useEnvironmentScope(
    scope?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const targets = useMemo(
    () => quickActionGitTargets(scope?.thread?.workspace, cwd),
    [scope?.thread?.workspace, cwd],
  );
  const stateAtom = useMemo(
    () =>
      Atom.make((get) =>
        targets.map((target) => {
          const environmentId = scope?.environmentId;
          const status =
            environmentId && !target.unavailable
              ? Option.getOrNull(
                  AsyncResult.value(
                    get(vcsEnvironment.status({ environmentId, input: { cwd: target.cwd } })),
                  ),
                )
              : null;
          const busy = environmentId
            ? get(vcsActionManager.stateAtom({ environmentId, cwd: target.cwd })).isRunning
            : false;
          return { ...target, status, action: resolveQuickActionGit(status, busy) };
        }),
      ),
    [scope?.environmentId, targets],
  );
  const repositories = useAtomValue(stateAtom);
  const loadStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const preparing = useRef(new Set<string>());
  const mounted = useRef(true);
  const [publishCwd, setPublishCwd] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const items: CommandPaletteActionItem[] = scope
    ? repositories.map((repository) => {
        const { environmentId, thread } = scope;
        const target = { environmentId, cwd: repository.cwd };
        const value = `quick-action:git:${repository.cwd}`;
        const action = repository.action;
        const assertWriteAccess = () => {
          if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope))
            throw new Error("This connection cannot change source control.");
        };
        const icon =
          action.kind === "run_pull" ? (
            <CloudDownloadIcon className={ITEM_ICON_CLASS} />
          ) : action.action === "commit" ? (
            <GitCommitIcon className={ITEM_ICON_CLASS} />
          ) : (
            <CloudUploadIcon className={ITEM_ICON_CLASS} />
          );

        const readCurrentAction = async () => {
          assertWriteAccess();
          const fresh = await loadStatus({ environmentId, input: { cwd: target.cwd } });
          if (fresh._tag === "Failure") throw squashAtomCommandFailure(fresh);
          assertWriteAccess();
          const current = resolveQuickActionGit(
            fresh.value,
            registry.get(vcsActionManager.stateAtom(target)).isRunning,
          );
          if (current.disabled) throw new Error(current.hint ?? "This action is unavailable.");
          if (
            !sameQuickActionGit(
              action,
              current,
              repository.status?.refName ?? null,
              fresh.value.refName,
            )
          ) {
            throw new Error("Repository status changed. Choose the updated action.");
          }
          return { status: fresh.value, action: current };
        };

        let started = false;
        const execute = async (
          kind: "pull" | GitStackedAction,
          featureBranch = false,
          recheck = false,
        ) => {
          if (started) return;
          started = true;
          if (recheck) await readCurrentAction();
          assertWriteAccess();
          if (
            featureBranch &&
            thread &&
            !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
          )
            throw new Error("This connection cannot change the thread's branch.");
          close();
          const progress = toastManager.add({
            type: "loading",
            title: `${action.label} · ${repository.label}`,
          });
          try {
            if (kind === "pull") {
              const result = await vcsActionManager.track(
                registry,
                target,
                { operation: "pull", label: "Pulling latest changes…" },
                () => pull({ environmentId, input: { cwd: target.cwd } }),
              );
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              toastManager.update(progress, {
                type: "success",
                title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
                description: repository.label,
              });
            } else {
              const result = await runAtomCommand(
                registry,
                vcsActionManager.runStackedAction(target),
                {
                  actionId: randomUUID(),
                  action: kind,
                  featureBranch,
                  ...(thread ? { threadId: thread.id } : {}),
                  ...(scope.projectId ? { projectId: scope.projectId } : {}),
                },
                { reportFailure: false },
              );
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              const branch = resolveThreadBranchUpdate(result.value);
              if (
                thread &&
                branch &&
                !hasRepositorySet(thread.workspace) &&
                readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
              ) {
                const updated = await updateMetadata({
                  environmentId,
                  input: {
                    threadId: thread.id,
                    ...resolveThreadBranchMetadataPatch(branch.branch, thread.branch),
                  },
                });
                if (updated._tag === "Failure") throw squashAtomCommandFailure(updated);
              }
              toastManager.update(progress, {
                type: "success",
                title: result.value.toast.title,
                description: result.value.toast.description ?? repository.label,
              });
            }
          } catch (error) {
            toastManager.update(progress, {
              type: "error",
              title: `${repository.label}: action failed`,
              description: error instanceof Error ? error.message : "Try again.",
            });
          } finally {
            registry.refresh(vcsEnvironment.status({ environmentId, input: { cwd: target.cwd } }));
          }
        };

        const run: CommandPaletteActionItem["run"] = async () => {
          if (preparing.current.has(value)) return;
          preparing.current.add(value);
          try {
            const { status, action: current } = await readCurrentAction();
            if (!mounted.current) return;
            if (current.kind === "open_publish") {
              setPublishCwd(target.cwd);
              return;
            }
            if (current.kind === "run_pull") {
              await execute("pull");
              return;
            }
            const kind = current.action;
            if (!kind) return;
            if (
              kind !== "commit" &&
              requiresDefaultBranchConfirmation(kind, status.isDefaultRef ?? false)
            ) {
              const copy = resolveDefaultBranchActionDialogCopy({
                action: kind,
                branchName: status.refName!,
                includesCommit: status.hasWorkingTreeChanges,
                ...(status.sourceControlProvider
                  ? { terminology: getChangeRequestTerminology(status.sourceControlProvider) }
                  : {}),
              });
              openCommandPalette({
                view: {
                  addonIcon: icon,
                  groups: [
                    {
                      value: "quick-action-git-confirm",
                      label: copy.title,
                      items: [
                        {
                          kind: "action",
                          value: `${value}:feature`,
                          title: "Create feature ref and continue",
                          description: repository.label,
                          searchTerms: ["feature", "branch"],
                          disabled: !!thread && !canOperate,
                          icon,
                          run: () => execute(kind, true, true),
                        },
                        {
                          kind: "action",
                          value: `${value}:confirm`,
                          title: copy.continueLabel,
                          description: repository.label,
                          searchTerms: ["confirm", status.refName!],
                          icon,
                          run: () => execute(kind, false, true),
                        },
                      ],
                    },
                  ],
                },
              });
            } else await execute(kind);
          } finally {
            preparing.current.delete(value);
          }
        };
        return {
          kind: "action",
          value,
          icon,
          keepOpen: true,
          title: repositories.length > 1 ? `${repository.label} — ${action.label}` : action.label,
          description: !canWrite
            ? "This connection cannot change source control."
            : describeQuickActionGit(repository),
          searchTerms: [
            "git",
            "commit",
            "push",
            "pull",
            "pr",
            "publish",
            action.label,
            repository.label,
          ],
          disabled: !canWrite || !!repository.unavailable || action.disabled,
          run,
        };
      })
    : [];

  const summary = summarizeQuickActionGit(repositories);
  const entry: CommandPaletteActionItem | null =
    items.length === 0
      ? null
      : {
          ...items[0]!,
          value: "quick-action:git",
          title: summary.label,
          description: !canWrite
            ? "This connection cannot change source control."
            : summary.description,
          disabled: !canWrite || summary.disabled,
          searchTerms: [
            "git",
            "commit",
            "push",
            "pull",
            "pr",
            "sync",
            ...repositories.map((repository) => repository.label),
          ],
          run:
            items.length === 1
              ? items[0]!.run
              : async () =>
                  openCommandPalette({
                    view: {
                      addonIcon: items[0]!.icon,
                      groups: [
                        {
                          value: "quick-action-git-repositories",
                          label: "Choose a repository",
                          items,
                        },
                      ],
                    },
                  }),
        };
  return {
    items: entry ? [entry] : [],
    repositoryItems: items,
    dialog:
      publishCwd && scope ? (
        <PublishRepositoryDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPublishCwd(null);
              close();
            }
          }}
          environmentId={scope.environmentId}
          threadRef={
            scope.thread ? { environmentId: scope.environmentId, threadId: scope.thread.id } : null
          }
          gitCwd={publishCwd}
        />
      ) : null,
  };
}
