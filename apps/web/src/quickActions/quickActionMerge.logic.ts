import type { PullRequestDetail } from "@t3tools/contracts";
import {
  allowedPullRequestMergeMethods,
  resolveThreadPanelPullRequestAction,
} from "../components/pullRequest/pullRequestDetail.logic";

/** All selected PRs must allow the method the reader confirms. Rechecked in the write lane. */
export function quickActionMergeMethods(details: readonly PullRequestDetail[]) {
  if (
    details.length === 0 ||
    details.some((detail) => resolveThreadPanelPullRequestAction(detail) !== "merge")
  )
    return [];
  return allowedPullRequestMergeMethods(details[0]!).filter((method) =>
    details.every((detail) => allowedPullRequestMergeMethods(detail).includes(method)),
  );
}
