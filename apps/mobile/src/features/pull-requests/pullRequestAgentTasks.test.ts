import { describe, expect, it } from "vite-plus/test";
import {
  appendPullRequestAgentPrompt,
  pullRequestAgentActions,
  pullRequestAgentPrompt,
  pullRequestAgentThread,
} from "./pullRequestAgentTasks";
import { IsoDateTime, ProjectId, ThreadId, type PullRequestDetail } from "@t3tools/contracts";
const pr = {
  state: "open",
  mergeability: "conflicting",
  baseComparison: "behind",
} as PullRequestDetail;
describe("PR agent tasks", () => {
  it("continues a single linked thread, but keeps an explicit new-thread choice separate", () => {
    const thread = {
      id: ThreadId.make("thread-one"),
      projectId: ProjectId.make("project-one"),
      title: "Existing work",
      archivedAt: null,
    };
    expect(pullRequestAgentThread([thread])).toBe(thread);
    expect(pullRequestAgentThread([thread], "new")).toBeUndefined();
    expect(pullRequestAgentThread([thread], "missing")).toBeUndefined();
    expect(pullRequestAgentThread([])).toBeUndefined();
    const archived = {
      ...thread,
      id: ThreadId.make("thread-two"),
      archivedAt: IsoDateTime.make("2026-10-09T10:00:00.000Z"),
    };
    expect(pullRequestAgentThread([thread, archived])).toBeUndefined();
    expect(pullRequestAgentThread([thread, archived], archived.id)).toBe(archived);
  });
  it("replaces the helper's own text when switching tasks, keeping user edits", () => {
    const first = appendPullRequestAgentPrompt("My question", "explain");
    const next = appendPullRequestAgentPrompt(first, "feedback", pullRequestAgentPrompt("explain"));
    expect(next).toBe(`My question\n\n${pullRequestAgentPrompt("feedback")}`);
    expect(appendPullRequestAgentPrompt(next, "ask", pullRequestAgentPrompt("feedback"))).toBe(
      "My question",
    );
    const edited = `${first} with my own edit`;
    expect(appendPullRequestAgentPrompt(edited, "ask", pullRequestAgentPrompt("explain"))).toBe(
      edited,
    );
  });
  it("requires the PR checkout before editing and fresh unresolved feedback", () => {
    expect(pullRequestAgentPrompt("feedback")).toContain("Fetch the latest review threads");
    expect(pullRequestAgentPrompt("feedback")).toContain("skip resolved feedback");
    for (const task of ["feedback", "conflicts"] as const)
      expect(pullRequestAgentPrompt(task)).toContain("prepare the PR in its own worktree");
  });
  it("offers conflicts and base updates only where they apply, and watch only on supported environments", () => {
    expect(pullRequestAgentActions(pr, true).every((action) => !action.disabled)).toBe(true);
    const actions = pullRequestAgentActions(
      {
        ...pr,
        mergeability: "mergeable",
      },
      false,
    );
    expect(actions.find((action) => action.task === "conflicts")?.disabled).toBe(true);
    expect(actions.find((action) => action.task === "watch")?.disabled).toBe(true);
    const current = pullRequestAgentActions(
      {
        ...pr,
        baseComparison: "up-to-date",
      },
      true,
    );
    expect(current.filter((action) => action.disabled).map((action) => action.task)).toEqual([
      "rebase",
      "merge-base",
    ]);
    const closed = pullRequestAgentActions(
      {
        ...pr,
        state: "merged",
      },
      true,
    );
    expect(closed.filter((action) => action.disabled).map((action) => action.task)).toEqual([
      "feedback",
      "conflicts",
      "rebase",
      "merge-base",
      "watch",
    ]);
  });
});
