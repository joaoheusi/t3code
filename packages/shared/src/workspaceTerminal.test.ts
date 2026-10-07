import { describe, expect, it } from "@effect/vitest";
import { CommandId, type ThreadWorkspace } from "@t3tools/contracts";
import { resolveWorkspaceTerminal } from "./workspaceTerminal.ts";
const binding = (id: string, checkoutPath: string) => ({
  id,
  label: id,
  sourcePath: checkoutPath,
  checkoutPath,
  mode: "current" as const,
  branch: "main",
  head: "abc",
  baseCommit: "abc",
  commonDir: checkoutPath + "/.git",
  state: "ready" as const,
  owned: false,
  error: null,
});
const workspace: ThreadWorkspace = {
  schemaVersion: 1,
  revision: 1,
  operationId: CommandId.make("test"),
  state: "ready",
  primaryBindingId: "api",
  bindings: [binding("api", "/api"), binding("web", "/worktrees/web")],
};
describe("workspace terminal ownership", () => {
  it("keeps secondary terminals on the actual worktree during drawer reopen", () => {
    expect(resolveWorkspaceTerminal(workspace, "repo:web:123").checkoutPath).toBe("/worktrees/web");
    expect(resolveWorkspaceTerminal(workspace, "term-1").checkoutPath).toBe("/api");
  });
  it("refuses unknown repository ids and unfinished workspaces instead of using primary", () => {
    expect(() => resolveWorkspaceTerminal(workspace, "repo:deleted:123")).toThrow(
      "repository is unavailable",
    );
    expect(() =>
      resolveWorkspaceTerminal({ ...workspace, state: "failed" }, "repo:web:123"),
    ).toThrow("repository is unavailable");
  });
});
