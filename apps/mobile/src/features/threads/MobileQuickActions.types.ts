import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export type QuickActionsTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftKey: string;
  readonly threadId?: ThreadId;
};
