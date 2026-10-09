import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { quickActionMergeMethods } from "./quickActionMerge.logic";
import { openCommandPalette } from "../commandPaletteBus";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../components/CommandPalette.logic";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  resolveThreadPanelPullRequestAction,
} from "../components/pullRequest/pullRequestDetail.logic";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { toastManager } from "../components/ui/toast";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

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
        const result = await loadDetail({
          environmentId,
          input: { ...reference, allowStale: false },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (resolveThreadPanelPullRequestAction(result.value) !== "merge")
          throw new Error(
            `${reference.repository} #${reference.number} is not ready to merge. Check its CI, conflicts, draft status, and permissions.`,
          );
        details.push(result.value);
      }
      const methods = quickActionMergeMethods(details);
      if (methods.length === 0)
        throw new Error(
          "These pull requests have no allowed merge method in common. Select them separately.",
        );
      let started = false;
      const merge = async (method: PullRequestMergeMethod) => {
        if (started) return;
        started = true;
        const progress = toastManager.add({
          type: "loading",
          title: `Merging ${references.length} pull request${references.length === 1 ? "" : "s"}…`,
        });
        const failures: string[] = [];
        let merged = 0;
        for (const reference of references) {
          try {
            const result = await runAction({
              environmentId,
              input: {
                ...reference,
                action: "merge",
                resolveMergeMethod: (detail) => {
                  if (!quickActionMergeMethods([detail]).includes(method))
                    throw new Error(
                      "This pull request's status or allowed merge methods changed. Review it again.",
                    );
                  return method;
                },
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            merged++;
          } catch (error) {
            failures.push(
              `${reference.repository} #${reference.number}: ${error instanceof Error ? error.message : "Merge failed."}`,
            );
          }
        }
        toastManager.update(progress, {
          type: failures.length ? "error" : "success",
          title: `Merged ${merged} of ${references.length} pull requests`,
          ...(failures.length ? { description: failures.join("\n") } : {}),
        });
      };
      const targets = references
        .map((reference) => `${reference.repository} #${reference.number}`)
        .join(", ");
      openCommandPalette({
        view: {
          addonIcon: <PullRequestGlyph.merged className={ADDON_ICON_CLASS} />,
          groups: [
            {
              value: "quick-action-merge-methods",
              label: `Confirm merge · ${targets}`,
              items: methods.map((method): CommandPaletteActionItem => ({
                kind: "action",
                value: `quick-action-merge:${method}`,
                searchTerms: [method, PULL_REQUEST_MERGE_METHOD_LABELS[method]],
                title: PULL_REQUEST_MERGE_METHOD_LABELS[method],
                description: `Merge ${references.length} pull request${references.length === 1 ? "" : "s"} now`,
                icon: <PullRequestGlyph.merged className={ITEM_ICON_CLASS} />,
                run: () => merge(method),
              })),
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
