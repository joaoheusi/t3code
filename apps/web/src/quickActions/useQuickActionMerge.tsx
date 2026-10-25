import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import {
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
  quickActionMergeActionInput,
  quickActionMergeKind,
  quickActionMergePlanLabel,
  quickActionMergePlanSummary,
  quickActionMergeResultTitle,
  type QuickActionMergeKind,
  type QuickActionMergePlan,
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

type MergePlan = QuickActionMergePlan<PullRequestRef>;

/**
 * Stacks a method choice on the selection view so Back returns to it, then merges the whole
 * selection, arming auto-merge where required checks still run. With no shared method, each PR
 * uses its default instead of repeating the flow per repository.
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
      const kinds: QuickActionMergeKind[] = [];
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
        const state = pullRequestDetailMergeState(result.value);
        const kind = quickActionMergeKind(state);
        if (kind === null)
          throw new Error(
            `${reference.repository} #${reference.number}: ${pullRequestMergeBlocker(state) ?? "Not ready to merge"}.`,
          );
        details.push(result.value);
        kinds.push(kind);
      }
      const defaults: MergePlan[] = references.map((reference, index) => {
        const method = quickActionMergeMethod(details[index]!);
        if (method === null)
          throw new Error(
            `${reference.repository} #${reference.number}: You can't merge this pull request.`,
          );
        return { reference, kind: kinds[index]!, method };
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
        const succeeded: MergePlan[] = [];
        const failures: string[] = [];
        for (const plan of plans) {
          const { reference } = plan;
          toastManager.update(progress, {
            description: `${reference.repository} #${reference.number}`,
          });
          try {
            const result = await runAction({
              environmentId,
              input: quickActionMergeActionInput(plan),
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            succeeded.push(plan);
          } catch (error) {
            failures.push(
              `${reference.repository} #${reference.number}: ${error instanceof Error ? error.message : "Merge failed."}`,
            );
          }
        }
        toastManager.update(progress, {
          type: failures.length ? "error" : "success",
          title: quickActionMergeResultTitle(plans, succeeded),
          description:
            [
              ...succeeded.map(
                (plan) =>
                  `${plan.reference.repository} #${plan.reference.number} · ${quickActionMergePlanLabel(plan)}`,
              ),
              ...failures,
            ].join("\n") || undefined,
        });
      };
      const targets = references
        .map((reference) => `${reference.repository} #${reference.number}`)
        .join(", ");
      const items: CommandPaletteActionItem[] =
        common.length > 0
          ? common.map((method): CommandPaletteActionItem => ({
              kind: "action",
              value: `quick-action-merge:${method}`,
              searchTerms: [method, PULL_REQUEST_MERGE_METHOD_LABELS[method]],
              title: PULL_REQUEST_MERGE_METHOD_LABELS[method],
              description: quickActionMergePlanSummary(defaults),
              icon: <PullRequestGlyph.merged className={ITEM_ICON_CLASS} />,
              run: () => merge(defaults.map((plan) => ({ ...plan, method }))),
            }))
          : [
              {
                kind: "action",
                value: "quick-action-merge:defaults",
                searchTerms: ["merge", "default", "each repository"],
                title: "Merge each with its default method",
                description: defaults
                  .map(
                    (plan) =>
                      `${plan.reference.repository} #${plan.reference.number} · ${quickActionMergePlanLabel(plan)}`,
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
