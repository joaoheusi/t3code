import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  hasRepositorySet,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { CloudDownloadIcon, CloudUploadIcon, GitCommitIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { openCommandPalette } from "../commandPaletteBus";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { PublishRepositoryDialog } from "../components/GitActionsControl";
import {
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveThreadBranchMetadataPatch,
  resolveThreadBranchUpdate,
} from "../components/GitActionsControl.logic";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { threadEnvironment } from "../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import type { QuickActionScope } from "./quickActionRunner";
import {
  quickActionGitTargets,
  describeQuickActionGit,
  describeQuickActionGitConfirmations,
  planQuickActionGitBatch,
  quickActionGitRowTitle,
  summarizeQuickActionGit,
  resolveQuickActionGit,
  sameQuickActionGit,
  type GitQuickAction,
} from "@t3tools/client-runtime/quickActionGit";

/** A repository's fresh status and the action it will run, checked against what was shown. */
interface PreparedGitAction {
  readonly status: VcsStatusResult;
  readonly action: GitQuickAction;
}

/** The write one repository performs; single and batch runs share it and own their own feedback. */
interface RepositoryGitHandler {
  readonly value: string;
  readonly label: string;
  readonly cwd: string;
  readonly icon: ReactNode;
  readonly item: CommandPaletteActionItem;
  readonly checkStatus: () => Promise<PreparedGitAction>;
  readonly write: (
    prepared: PreparedGitAction,
    featureBranch: boolean,
    onPhase: (label: string) => void,
  ) => Promise<{ readonly title: string; readonly description?: string }>;
}

type BatchEntry = PreparedGitAction & { readonly handler: RepositoryGitHandler } & Pick<
    RepositoryGitHandler,
    "label" | "cwd"
  >;

/**
 * Runs a batch like the merge runner: checks every selected repository before
 * any write, then runs each one's own action in turn. Default-ref writes share
 * one stacked confirmation, so Back returns to the same selection.
 */
function useGitBatchRunner(input: {
  readonly close: () => void;
  readonly onPublish: (cwd: string) => void;
}) {
  const preparingBatch = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return async (
    handlers: readonly RepositoryGitHandler[],
    values: readonly string[],
    options: { readonly canOperate: boolean; readonly hasThread: boolean },
  ) => {
    const selected = handlers.filter((handler) => values.includes(handler.value));
    if (selected.length === 0 || preparingBatch.current) return;
    preparingBatch.current = true;
    try {
      const checkAll = async (): Promise<BatchEntry[]> => {
        const entries: BatchEntry[] = [];
        for (const handler of selected) {
          const prepared = await handler.checkStatus();
          entries.push({ handler, label: handler.label, cwd: handler.cwd, ...prepared });
        }
        return entries;
      };
      const checking = toastManager.add({
        type: "loading",
        title: "Checking repository status…",
      });
      let entries: BatchEntry[];
      try {
        entries = await checkAll();
      } finally {
        toastManager.close(checking);
      }
      if (!mounted.current) return;
      const plan = planQuickActionGitBatch(entries);
      if (plan.kind === "blocked") throw new Error(plan.reason);
      if (plan.kind === "publish") {
        input.onPublish(plan.repository.cwd);
        return;
      }
      const confirmedCwds = new Set(plan.confirmations.map((entry) => entry.cwd));
      let started = false;
      const executeBatch = async (featureBranch: boolean, recheck: boolean) => {
        if (started) return;
        started = true;
        let list = entries;
        try {
          if (recheck) {
            list = await checkAll();
            const replanned = planQuickActionGitBatch(list);
            if (
              replanned.kind !== "run" ||
              replanned.confirmations.length !== confirmedCwds.size ||
              replanned.confirmations.some((entry) => !confirmedCwds.has(entry.cwd))
            ) {
              throw new Error("Repository status changed. Choose the updated action.");
            }
          }
        } catch (error) {
          // No write has started, so the confirmation can safely be retried.
          started = false;
          throw error;
        }
        input.close();
        const progress = toastManager.add({
          type: "loading",
          title: `Syncing ${list.length} ${list.length === 1 ? "repository" : "repositories"}…`,
        });
        const succeeded: string[] = [];
        const failures: string[] = [];
        let firstTitle: string | null = null;
        for (const entry of list) {
          toastManager.update(progress, {
            title: `${entry.action.label}…`,
            description: entry.label,
          });
          try {
            const result = await entry.handler.write(
              entry,
              featureBranch && confirmedCwds.has(entry.cwd),
              (label) => toastManager.update(progress, { title: label }),
            );
            firstTitle ??= result.title;
            succeeded.push(`${entry.label} · ${result.title}`);
          } catch (error) {
            failures.push(
              `${entry.label}: ${error instanceof Error ? error.message : "Action failed."}`,
            );
          }
        }
        toastManager.update(progress, {
          type: failures.length ? "error" : "success",
          title: failures.length
            ? `${succeeded.length} of ${list.length} repositories synced`
            : list.length === 1
              ? (firstTitle ?? "Synced")
              : `Synced ${list.length} repositories`,
          description: [...succeeded, ...failures].join("\n") || undefined,
        });
      };
      if (plan.confirmations.length === 0) {
        await executeBatch(false, false);
        return;
      }
      const first = plan.confirmations[0]!;
      const affected = describeQuickActionGitConfirmations(plan.confirmations);
      const others = entries.length - plan.confirmations.length;
      const description =
        others > 0
          ? `${affected} · plus ${others} other ${others === 1 ? "repository" : "repositories"}`
          : affected;
      const onlyAction = plan.confirmations.length === 1 ? first.action.action : undefined;
      const onlyCopy =
        onlyAction && onlyAction !== "commit"
          ? resolveDefaultBranchActionDialogCopy({
              action: onlyAction,
              branchName: first.status.refName!,
              includesCommit: first.status.hasWorkingTreeChanges,
              ...(first.status.sourceControlProvider
                ? {
                    terminology: getSourceControlPresentation(first.status.sourceControlProvider)
                      .terminology,
                  }
                : {}),
            })
          : null;
      openCommandPalette({
        pushView: {
          addonIcon: first.handler.icon,
          groups: [
            {
              value: "quick-action-git-batch-confirm",
              label: onlyCopy?.title ?? `Write to default refs? · ${affected}`,
              items: [
                {
                  kind: "action",
                  value: "quick-action:git:batch:feature",
                  keepOpen: true,
                  title: "Create feature ref and continue",
                  description,
                  searchTerms: ["feature", "branch"],
                  disabled: options.hasThread && !options.canOperate,
                  icon: first.handler.icon,
                  run: () => executeBatch(true, true),
                },
                {
                  kind: "action",
                  value: "quick-action:git:batch:confirm",
                  keepOpen: true,
                  title: onlyCopy?.continueLabel ?? "Continue on default refs",
                  description,
                  searchTerms: ["confirm", ...plan.confirmations.map((entry) => entry.label)],
                  icon: first.handler.icon,
                  run: () => executeBatch(false, true),
                },
              ],
            },
          ],
        },
      });
    } finally {
      preparingBatch.current = false;
    }
  };
}

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
  const targets = quickActionGitTargets(scope?.thread?.workspace, cwd);
  const stateAtom = Atom.make((get) =>
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
      return { ...target, status, busy, action: resolveQuickActionGit(status, busy) };
    }),
  );
  const repositories = useAtomValue(stateAtom);
  const loadStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const preparing = useRef(new Set<string>());
  const mounted = useRef(true);
  const [publishCwd, setPublishCwd] = useState<string | null>(null);
  const runGitBatch = useGitBatchRunner({ close, onPublish: setPublishCwd });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handlers: RepositoryGitHandler[] = scope
    ? repositories.map((repository) => {
        const { environmentId, thread } = scope;
        const target = { environmentId, cwd: repository.cwd };
        const value = `quick-action:git:${repository.cwd}`;
        const action = repository.action;
        const assertWriteAccess = () => {
          if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope))
            throw new Error("This connection cannot change source control.");
        };
        const icon = repository.busy ? (
          <Spinner size="md" tone="muted" aria-label="Git action in progress" />
        ) : action.kind === "run_pull" ? (
          <CloudDownloadIcon className={ITEM_ICON_CLASS} />
        ) : action.action === "commit" ? (
          <GitCommitIcon className={ITEM_ICON_CLASS} />
        ) : (
          <CloudUploadIcon className={ITEM_ICON_CLASS} />
        );

        const checkStatus = async (): Promise<PreparedGitAction> => {
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

        const checkStatusWithToast = async (): Promise<PreparedGitAction> => {
          const progress = toastManager.add({
            type: "loading",
            title: "Checking repository status…",
            description: repository.label,
          });
          try {
            return await checkStatus();
          } finally {
            toastManager.close(progress);
          }
        };

        const write: RepositoryGitHandler["write"] = async (prepared, featureBranch, onPhase) => {
          assertWriteAccess();
          if (
            featureBranch &&
            thread &&
            !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
          )
            throw new Error("This connection cannot change the thread's branch.");
          try {
            if (prepared.action.kind === "run_pull") {
              const result = await vcsActionManager.track(
                registry,
                target,
                { operation: "pull", label: "Pulling latest changes…" },
                () => pull({ environmentId, input: { cwd: target.cwd } }),
              );
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              return {
                title: result.value.status === "pulled" ? "Pulled" : "Already up to date",
              };
            }
            const kind = prepared.action.action;
            if (!kind) throw new Error("This action is unavailable.");
            const result = await runAtomCommand(
              registry,
              vcsActionManager.runStackedAction(target),
              {
                actionId: randomUUID(),
                action: kind,
                featureBranch,
                onProgress: (event) => {
                  if (
                    event.kind === "phase_started" ||
                    event.kind === "hook_started" ||
                    event.kind === "hook_finished"
                  ) {
                    onPhase(
                      registry.get(vcsActionManager.stateAtom(target)).currentLabel ??
                        `${prepared.action.label}…`,
                    );
                  }
                },
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
            return {
              title: result.value.toast.title,
              ...(result.value.toast.description
                ? { description: result.value.toast.description }
                : {}),
            };
          } finally {
            registry.refresh(vcsEnvironment.status({ environmentId, input: { cwd: target.cwd } }));
          }
        };

        let started = false;
        const execute = async (featureBranch: boolean, preparedInput?: PreparedGitAction) => {
          if (started) return;
          started = true;
          let prepared = preparedInput;
          try {
            // A confirmation rechecks first; no write has started yet, so it can be retried.
            prepared ??= await checkStatusWithToast();
            assertWriteAccess();
            if (
              featureBranch &&
              thread &&
              !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
            )
              throw new Error("This connection cannot change the thread's branch.");
          } catch (error) {
            started = false;
            throw error;
          }
          close();
          const progress = toastManager.add({
            type: "loading",
            title: `${prepared.action.label}…`,
            description: repository.label,
          });
          try {
            const result = await write(prepared, featureBranch, (label) =>
              toastManager.update(progress, { title: label }),
            );
            toastManager.update(progress, {
              type: "success",
              title: result.title,
              description: result.description ?? repository.label,
            });
          } catch (error) {
            toastManager.update(progress, {
              type: "error",
              title: `${repository.label}: action failed`,
              description: error instanceof Error ? error.message : "Try again.",
            });
          }
        };

        const run: CommandPaletteActionItem["run"] = async () => {
          if (preparing.current.has(value)) return;
          preparing.current.add(value);
          try {
            const prepared = await checkStatusWithToast();
            if (!mounted.current) return;
            if (prepared.action.kind === "open_publish") {
              setPublishCwd(target.cwd);
              return;
            }
            if (prepared.action.kind === "run_pull") {
              await execute(false, prepared);
              return;
            }
            const kind = prepared.action.action;
            if (!kind) return;
            const status = prepared.status;
            if (
              kind !== "commit" &&
              requiresDefaultBranchConfirmation(kind, status.isDefaultRef ?? false)
            ) {
              const copy = resolveDefaultBranchActionDialogCopy({
                action: kind,
                branchName: status.refName!,
                includesCommit: status.hasWorkingTreeChanges,
                ...(status.sourceControlProvider
                  ? {
                      terminology: getSourceControlPresentation(status.sourceControlProvider)
                        .terminology,
                    }
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
                          keepOpen: true,
                          title: "Create feature ref and continue",
                          description: repository.label,
                          searchTerms: ["feature", "branch"],
                          disabled: !!thread && !canOperate,
                          icon,
                          run: () => execute(true),
                        },
                        {
                          kind: "action",
                          value: `${value}:confirm`,
                          keepOpen: true,
                          title: copy.continueLabel,
                          description: repository.label,
                          searchTerms: ["confirm", status.refName!],
                          icon,
                          run: () => execute(false),
                        },
                      ],
                    },
                  ],
                },
              });
            } else await execute(false, prepared);
          } finally {
            preparing.current.delete(value);
          }
        };
        const item: CommandPaletteActionItem = {
          kind: "action",
          value,
          icon,
          keepOpen: true,
          title: repositories.length > 1 ? quickActionGitRowTitle(repository) : action.label,
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
        return {
          value,
          label: repository.label,
          cwd: repository.cwd,
          icon,
          item,
          checkStatus,
          write,
        };
      })
    : [];
  const items = handlers.map((handler) => handler.item);

  const summary = summarizeQuickActionGit(repositories);
  const entryIcon = repositories.some((repository) => repository.busy) ? (
    <Spinner size="md" tone="muted" aria-label="Git action in progress" />
  ) : (
    items[0]?.icon
  );
  const entryBase = {
    value: "quick-action:git",
    title: summary.label,
    description: !canWrite ? "This connection cannot change source control." : summary.description,
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
  };
  const gitEntry: CommandPaletteActionItem | CommandPaletteSubmenuItem | null =
    items.length === 0
      ? null
      : items.length === 1
        ? { ...items[0]!, ...entryBase, icon: entryIcon }
        : {
            ...entryBase,
            kind: "submenu",
            icon: entryIcon,
            addonIcon: items[0]!.icon,
            // Rows only toggle in this view, like the other quick actions; the
            // submit runs every selected repository's own action in one pass.
            multiSelect: {
              actionLabel: "Sync selected",
              keepOpen: true,
              run: (values) =>
                runGitBatch(handlers, values, { canOperate, hasThread: !!scope?.thread }),
            },
            groups: [
              {
                value: "quick-action-git-repositories",
                label: "Choose repositories",
                items,
              },
            ],
          };
  return {
    items: gitEntry ? [gitEntry] : [],
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
