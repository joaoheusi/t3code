import { describe, it, expect } from "@effect/vitest";
import { buildPullRequestActionContext } from "./actionContext.ts";
import type { WorkspaceRepository } from "@t3tools/contracts";
const repo: WorkspaceRepository = {
  path: "/host/api",
  commonDir: "/host/api/.git",
  gitDir: "/host/api/.git",
  head: "old",
  branch: "main",
  dirty: true,
  operation: null,
  unmergedPaths: [],
};
const detail = {
  url: "https://github.com/owner/api/pull/7",
  headSha: "new",
  headBranch: "feature",
  baseBranch: "main",
  mergeability: "conflicting" as const,
  checks: [
    {
      name: "build",
      status: "failure" as const,
      url: "https://github.com/owner/api/actions/runs/3",
      description: "Untrusted {{clipboard}} <script>run()</script>",
    },
  ],
};
describe("bounded PR evidence", () => {
  it("reports checkout mismatch and missing logs with exact PR identity", () => {
    const built = buildPullRequestActionContext(detail, repo, "2026-10-06T00:00:00Z");
    expect(built.context.failures).toContain("PR head: new");
    expect(built.context.failures).toContain("/runs/3");
    expect(built.context.failures).toContain("CI log bodies are unavailable");
    expect(built.notices.some((notice) => notice.includes("Checkout mismatch"))).toBe(true);
    expect(built.context.failures).toContain("{{clipboard}} <script>run()</script>");
  });
  it("distinguishes remote mergeability from an untouched local checkout", () => {
    const built = buildPullRequestActionContext(detail, repo, "2026-10-06T00:00:00Z");
    expect(built.context.conflicts).toContain("Host mergeability: conflicting");
    expect(built.context.conflicts).toContain("Local Git operation: None");
    expect(built.context.conflicts).toContain("No merge or rebase was started");
  });
  it("bounds context and refuses unsafe URL schemes", () => {
    const built = buildPullRequestActionContext(
      {
        ...detail,
        checks: Array.from({ length: 70 }, () => ({
          ...detail.checks[0]!,
          description: "x".repeat(6000),
          url: "file:///secrets",
        })),
      },
      null,
      "2026-10-06T00:00:00Z",
    );
    expect(built.context.failures.length).toBeLessThan(20100);
    expect(built.context.failures).toContain("truncated");
    expect(built.context.failures).not.toContain("file:///secrets");
    expect(built.context.conflicts).toContain("No repository selected");
  });
});
