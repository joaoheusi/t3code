import type { EnvironmentId, PullRequestRef, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";

import { classifyPullRequestChecks } from "../components/pullRequest/pullRequestDetail.logic";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";

/** Fetch only visible targets, sharing the detail query used by the PR panel. */
export function QuickActionPullRequestStatus({
  environmentId,
  reference,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly snapshot: ThreadPullRequestSnapshot | null;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } }),
  );
  const detail = query.data;
  if (detail?.state === "merged" || detail?.state === "closed")
    return <span>{detail.state === "merged" ? "Merged" : "Closed"}</span>;
  const checks = detail ? classifyPullRequestChecks(detail.checks) : snapshot?.checksState;
  const mergeability = detail?.mergeability ?? snapshot?.mergeability;
  const failing = checks === "failing";
  const passing = checks === "passing";
  const CheckIcon = failing ? CircleXIcon : passing ? CircleCheckIcon : CircleDashedIcon;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className={
          failing
            ? "flex items-center gap-1 text-destructive"
            : passing
              ? "flex items-center gap-1 text-success"
              : "flex items-center gap-1"
        }
      >
        <CheckIcon aria-hidden className="size-3 text-current" />
        {failing
          ? "CI failing"
          : passing
            ? "CI passing"
            : checks === "pending"
              ? "CI running"
              : checks === "none"
                ? "No checks"
                : "CI unknown"}
      </span>
      <span
        className={
          mergeability === "conflicting"
            ? "flex items-center gap-1 text-destructive"
            : "flex items-center gap-1"
        }
      >
        {mergeability === "conflicting" ? (
          <TriangleAlertIcon aria-hidden className="size-3 text-current" />
        ) : null}
        {mergeability === "conflicting"
          ? "Merge conflicts"
          : mergeability === "mergeable"
            ? "No conflicts"
            : "Conflicts unknown"}
      </span>
      {query.error ? (
        <span>Could not refresh status</span>
      ) : query.isPending ? (
        <span>Refreshing…</span>
      ) : null}
    </span>
  );
}
