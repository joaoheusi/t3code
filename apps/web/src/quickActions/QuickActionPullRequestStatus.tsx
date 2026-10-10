import type { EnvironmentId, PullRequestRef, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import {
  pullRequestSignalStatuses,
  unresolvedReviewThreads,
  type PullRequestSignalStatus,
  type QuickActionSignal,
} from "@t3tools/client-runtime/quickActionRunner";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  MessageSquareIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { classifyPullRequestChecks } from "../components/pullRequest/pullRequestDetail.logic";
import { pullRequestEnvironment } from "../state/pullRequests";
import { useEnvironmentQuery } from "../state/query";

function SignalStatus({ status }: { readonly status: PullRequestSignalStatus }) {
  const Icon =
    status.signal === "reviewThreads"
      ? MessageSquareIcon
      : status.signal === "conflicts"
        ? status.tone === "alert"
          ? TriangleAlertIcon
          : null
        : status.tone === "alert"
          ? CircleXIcon
          : status.tone === "ok"
            ? CircleCheckIcon
            : CircleDashedIcon;
  return (
    <span
      className={
        status.tone === "alert"
          ? "flex items-center gap-1 text-destructive"
          : status.tone === "ok" && status.signal === "ci"
            ? "flex items-center gap-1 text-success"
            : "flex items-center gap-1"
      }
    >
      {Icon ? <Icon aria-hidden className="size-3 text-current" /> : null}
      {status.label}
    </span>
  );
}

/**
 * The PR states an action acts on, and nothing else. Fetches only visible targets, sharing
 * the detail and activity queries used by the PR panel.
 */
export function QuickActionPullRequestStatus({
  environmentId,
  reference,
  snapshot,
  signals,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly snapshot: ThreadPullRequestSnapshot | null;
  readonly signals: readonly QuickActionSignal[];
}) {
  const needsDetail = signals.includes("ci") || signals.includes("conflicts");
  const needsActivity = signals.includes("reviewThreads");
  const detailQuery = useEnvironmentQuery(
    needsDetail
      ? pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } })
      : null,
  );
  const activityQuery = useEnvironmentQuery(
    needsActivity ? pullRequestEnvironment.activity({ environmentId, input: reference }) : null,
  );
  if (signals.length === 0) return null;
  const detail = detailQuery.data;
  if (detail?.state === "merged" || detail?.state === "closed")
    return <span>{detail.state === "merged" ? "Merged" : "Closed"}</span>;
  const statuses = pullRequestSignalStatuses(signals, {
    checks: detail ? classifyPullRequestChecks(detail.checks) : snapshot?.checksState,
    mergeability: detail?.mergeability ?? snapshot?.mergeability,
    reviewThreads: unresolvedReviewThreads(activityQuery.data),
  });
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {statuses.map((status) => (
        <SignalStatus key={status.signal} status={status} />
      ))}
      {detailQuery.error || activityQuery.error ? (
        <span>Could not refresh status</span>
      ) : detailQuery.isPending || activityQuery.isPending ? (
        <span>Refreshing…</span>
      ) : null}
    </span>
  );
}
