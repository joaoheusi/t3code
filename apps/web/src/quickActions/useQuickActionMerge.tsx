import type { EnvironmentId, PullRequestMergeMethod, PullRequestRef } from "@t3tools/contracts";
import {
  allowedPullRequestMergeMethods,
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
} from "@t3tools/client-runtime/pullRequestActions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef } from "react";

import { quickActionMergeMethod } from "./quickActionMerge.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../components/pullRequest/pullRequestDetail.logic";
import { toastManager } from "../components/ui/toast";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

/**
 * Merges every selected PR in one pass, like the other quick actions finish in their toggle
 * view. Fresh status is checked first; each PR then merges with its own default method, so
 * repositories that allow different methods never force a second pass.
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
      const plans: Array<{
        readonly reference: PullRequestRef;
        readonly method: PullRequestMergeMethod;
      }> = [];
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
        const method = quickActionMergeMethod(result.value);
        if (method === null)
          throw new Error(
            `${reference.repository} #${reference.number}: You can't merge this pull request.`,
          );
        plans.push({ reference, method });
      }
      toastManager.close(loading);
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
    } finally {
      toastManager.close(loading);
      preparing.current = false;
    }
  };
}
