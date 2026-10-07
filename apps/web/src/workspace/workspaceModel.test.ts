import { describe, expect, it } from "@effect/vitest";

import {
  primaryBindingRequest,
  repositoriesSummary,
  workspaceConfiguration,
  type DraftRepository,
} from "./workspaceModel";

const repository = (label: string, mode: DraftRepository["mode"]): DraftRepository => ({
  id: `id-${label}`,
  label,
  path: `/repos/${label}`,
  commonDir: `/repos/${label}/.git`,
  mode,
  branch: "main",
  head: "abc123",
});

describe("workspace configuration", () => {
  it("maps the toolbar's workspace choice onto the primary checkout", () => {
    const base = { label: "web", workspaceRoot: "/repos/web", branch: "main" };
    expect(primaryBindingRequest({ ...base, envMode: "local", worktreePath: null }).mode).toBe(
      "current",
    );
    expect(
      primaryBindingRequest({ ...base, envMode: "worktree", worktreePath: "/wt/web" }),
    ).toMatchObject({ mode: "existing-worktree", sourcePath: "/wt/web" });
    const fresh = primaryBindingRequest({ ...base, envMode: "worktree", worktreePath: null });
    expect(fresh).toMatchObject({ mode: "new-worktree", baseRef: "main" });
    expect(fresh.branch).toMatch(/^t3\/[0-9a-f]{8}$/);
  });

  it("names bindings after their repositories so worktree folders stay readable", () => {
    const configuration = workspaceConfiguration(
      primaryBindingRequest({
        label: "Web App",
        workspaceRoot: "/repos/web",
        envMode: "local",
        worktreePath: null,
        branch: null,
      }),
      [repository("api", "new-worktree"), repository("api", "current")],
      3,
    );
    expect(configuration.expectedRevision).toBe(3);
    expect(configuration.primaryBindingId).toBe("web-app");
    expect(configuration.bindings.map((binding) => binding.id)).toEqual([
      "web-app",
      "api",
      "api-2",
    ]);
    expect(configuration.bindings[1]).toMatchObject({ mode: "new-worktree", baseRef: "main" });
  });

  it("summarizes repositories without listing them all", () => {
    expect(repositoriesSummary(["web"])).toBe("web");
    expect(repositoriesSummary(["web", "api"])).toBe("web + api");
    expect(repositoriesSummary(["web", "api", "sdk"])).toBe("web + 2");
  });
});
