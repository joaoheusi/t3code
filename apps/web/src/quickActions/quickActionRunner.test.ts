import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  QuickAction,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { quickActionTargets } from "./quickActionRunner";

const action = (template: string): QuickAction => ({
  id: "action",
  name: "Action",
  description: "",
  aliases: [],
  tags: [],
  category: null,
  template,
  projectId: null,
  enabled: true,
  favorite: false,
  revision: 1,
  createdAt: "",
  updatedAt: "",
});
const link = (
  number: number,
  state: "open" | "merged" | null,
  bindingId?: string,
): ThreadPullRequestLink =>
  ({
    host: "github.com",
    repository: `acme/${bindingId ?? "web"}`,
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    source: "manual",
    linkedAt: "",
    snapshot: state === null ? null : { state },
    stack: null,
    ...(bindingId ? { bindingId } : {}),
  }) as ThreadPullRequestLink;
const thread = (
  pullRequests: ThreadPullRequestLink[],
  bindings: Array<{ id: string; label: string }> = [],
) =>
  ({
    id: "thread",
    pullRequests,
    ...(bindings.length ? { workspace: { bindings } } : {}),
  }) as unknown as EnvironmentThreadShell;
const scope = (shell: EnvironmentThreadShell | null) => ({
  environmentId: "env" as EnvironmentId,
  projectId: "project" as ProjectId,
  thread: shell,
});

describe("quickActionTargets", () => {
  it("runs plain text anywhere with a single target", () => {
    const targets = quickActionTargets(action("Review {{date}}"), scope(null));
    expect(targets).toEqual({
      kind: "ready",
      variants: [{ key: "|", label: null, choice: {} }],
    });
  });

  it("explains missing context instead of guessing", () => {
    expect(
      quickActionTargets(action("{{ci.failures}}"), scope(thread([link(1, "merged")]))),
    ).toEqual({
      kind: "unavailable",
      reason: "Link an open pull request first",
    });
    expect(quickActionTargets(action("{{thread.title}}"), scope(null)).kind).toBe("unavailable");
  });

  it("offers one variant per open pull request", () => {
    const targets = quickActionTargets(
      action("{{ci.failures}}"),
      scope(thread([link(1, "open"), link(2, null), link(3, "merged")])),
    );
    expect(targets.kind === "ready" && targets.variants.map((variant) => variant.label)).toEqual([
      "web #1",
      "web #2",
    ]);
  });

  it("asks for a repository only when the pull request is not bound to one", () => {
    const bindings = [
      { id: "web", label: "web" },
      { id: "api", label: "api" },
    ];
    const unbound = quickActionTargets(
      action("{{pr.conflicts}}"),
      scope(thread([link(7, "open")], bindings)),
    );
    expect(
      unbound.kind === "ready" && unbound.variants.map((variant) => variant.choice.bindingId),
    ).toEqual(["web", "api"]);
    const bound = quickActionTargets(
      action("{{pr.conflicts}}"),
      scope(thread([link(7, "open", "api")], bindings)),
    );
    expect(
      bound.kind === "ready" && bound.variants.map((variant) => variant.choice.bindingId),
    ).toEqual(["api"]);
  });
});
