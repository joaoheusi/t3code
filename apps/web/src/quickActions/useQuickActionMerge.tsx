import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  allowedPullRequestMergeMethods,
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
} from "@t3tools/client-runtime/pullRequestActions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { quickActionMergeMethod, quickActionMergeMethods } from "./quickActionMerge.logic";
import { openCommandPalette } from "../commandPaletteBus";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../components/CommandPalette.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../components/pullRequest/pullRequestDetail.logic";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { toastManager } from "../components/ui/toast";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

interface MergePlan {
  readonly reference: PullRequestRef;
  readonly method: PullRequestMergeMethod;
}

/**
 * Checks every selected PR, then stacks a method choice on the toggle view in the same palette
 * so Back returns to the selection. Choosing a method merges the whole selection in one pass.
 * When the repositories share no method, the choice falls back to each PR's default method
 * instead of making the reader repeat the flow per repository.
 */
export function useQuickActionMerge() {
  const loadDetail = useAtomQueryRunner(pullRequestEnvironment.detail, {
    reportFailure: false,
    refresh: true,
  });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const preparing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return async (environmentId: EnvironmentId, references: readonly PullRequestRef[]) => {
    if (preparing.current || references.length === 0) return;
    preparing.current = true;
    const loading = toastManager.add({
      type: "loading",
      title: "Checking pull requests before merging…",
    });
    try {
      const details: PullRequestDetail[] = [];
      for (const reference of references) {
        toastManager.update(loading, {
          description: `${reference.repository} #${reference.number}`,
        });
        const result = await loadDetail({
          environmentId,
          input: { ...reference, allowStale: false },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const blocker = pullRequestMergeBlocker(pullRequestDetailMergeState(result.value));
        if (blocker) throw new Error(`${reference.repository} #${reference.number}: ${blocker}.`);
        details.push(result.value);
      }
      const defaults: MergePlan[] = references.map((reference, index) => {
        const method = quickActionMergeMethod(details[index]!);
        if (method === null)
          throw new Error(
            `${reference.repository} #${reference.number}: You can't merge this pull request.`,
          );
        return { reference, method };
      });
      const common = quickActionMergeMethods(details);
      let started = false;
      const merge = async (plans: readonly MergePlan[]) => {
        if (started) return;
        started = true;
        const progress = toastManager.add({
          type: "loading",
          title: `Merging ${plans.length} pull request${plans.length === 1 ? "" : "s"}…`,
        });
        const merged: string[] = [];
        const failures: string[] = [];
        for (const { reference, method } of plans) {
          toastManager.update(progress, {
            description: `${reference.repository} #${reference.number}`,
          });
          try {
            const result = await runAction({
              environmentId,
              input: {
                ...reference,
                action: "merge",
                resolveMergeMethod: (detail) => {
                  if (
                    quickActionMergeMethod(detail) === null ||
                    !allowedPullRequestMergeMethods(detail).includes(method)
                  )
                    throw new Error(
                      "This pull request's status or allowed merge methods changed. Review it again.",
                    );
                  return method;
                },
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            merged.push(
              `${reference.repository} #${reference.number} · ${PULL_REQUEST_MERGE_METHOD_LABELS[method]}`,
            );
          } catch (error) {
            failures.push(
              `${reference.repository} #${reference.number}: ${error instanceof Error ? error.message : "Merge failed."}`,
            );
          }
        }
        toastManager.update(progress, {
          type: failures.length ? "error" : "success",
          title: `Merged ${merged.length} of ${plans.length} pull requests`,
          description: [...merged, ...failures].join("\n") || undefined,
        });
      };
      const targets = references
        .map((reference) => `${reference.repository} #${reference.number}`)
        .join(", ");
      const count = `${references.length} pull request${references.length === 1 ? "" : "s"}`;
      const items: CommandPaletteActionItem[] =
        common.length > 0
          ? common.map((method): CommandPaletteActionItem => ({
              kind: "action",
              value: `quick-action-merge:${method}`,
              searchTerms: [method, PULL_REQUEST_MERGE_METHOD_LABELS[method]],
              title: PULL_REQUEST_MERGE_METHOD_LABELS[method],
              description: `Merge ${count} now`,
              icon: <PullRequestGlyph.merged className={ITEM_ICON_CLASS} />,
              run: () => merge(references.map((reference) => ({ reference, method }))),
            }))
          : [
              {
                kind: "action",
                value: "quick-action-merge:defaults",
                searchTerms: ["merge", "default", "each repository"],
                title: "Merge each with its default method",
                description: defaults
                  .map(
                    ({ reference, method }) =>
                      `${reference.repository} #${reference.number} · ${PULL_REQUEST_MERGE_METHOD_LABELS[method]}`,
                  )
                  .join(", "),
                icon: <PullRequestGlyph.merged className={ITEM_ICON_CLASS} />,
                run: () => merge(defaults),
              },
            ];
      openCommandPalette({
        pushView: {
          addonIcon: <PullRequestGlyph.merged className={ADDON_ICON_CLASS} />,
          groups: [
            {
              value: "quick-action-merge-methods",
              label: `Confirm merge · ${targets}`,
              items,
            },
          ],
        },
      });
    } finally {
      toastManager.close(loading);
      preparing.current = false;
    }
  };
}
