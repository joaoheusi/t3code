import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  ActionContextInput,
  ActionContextResult,
  EnvironmentId,
  ProjectId,
  QuickAction,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  quickActionTargets,
  renderQuickActionSelection,
  insertQuickActionText,
} from "./quickActionRunner";

import { DraftId } from "../composerDraftStore";
import { readPreparedTask, dismissPreparedTask } from "./preparedTasks";

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

describe("selected quick action targets", () => {
  const choices = [1, 2].map((number) => ({
    pullRequest: { host: "github.com", repository: "acme/web", number },
  }));
  const contextFor = (input: ActionContextInput): ActionContextResult => ({
    threadTitle: "Fix both PRs",
    workspaceRevision: null,
    repositories: [],
    pullRequest: {
      url: `https://github.com/acme/web/pull/${input.pullRequest!.number}`,
      headSha: `head-${input.pullRequest!.number}`,
      observedAt: "2026-10-07T12:00:00.000Z",
      failures: `Failed check for PR ${input.pullRequest!.number}`,
      conflicts: "No conflicts",
    },
    notices: [],
  });

  it("prepares one ordered draft and preserves each environment and PR head", async () => {
    const requests: Array<[EnvironmentId, ActionContextInput]> = [];
    const rendered = await renderQuickActionSelection({
      action: action("Fix {{pr.url}}\n{{ci.failures}}"),
      scope: scope(thread([])),
      choices,
      resolveContext: async (environmentId, request) => {
        requests.push([environmentId, request]);
        return contextFor(request);
      },
    });
    expect(rendered.text).toBe(
      "Fix https://github.com/acme/web/pull/1\nFailed check for PR 1\n\n---\n\nFix https://github.com/acme/web/pull/2\nFailed check for PR 2",
    );
    expect(rendered.append).toBe(true);
    expect(
      requests.map(([environmentId, request]) => [environmentId, request.pullRequest?.number]),
    ).toEqual([
      ["env", 1],
      ["env", 2],
    ]);
    expect(rendered.contexts.map((context) => context.expectedHeadSha)).toEqual([
      "head-1",
      "head-2",
    ]);

    // A composer that went away gets one complete task, with both validations.
    const target = DraftId.make("batch-test-draft");
    expect(
      insertQuickActionText({
        target,
        invocation: null,
        action: action("{{ci.failures}}"),
        rendered,
        environmentId: scope(null).environmentId,
        projectId: scope(null).projectId,
      }),
    ).toBe(false);
    const prepared = readPreparedTask(target);
    expect(prepared?.prompt).toBe(rendered.text);
    expect(prepared?.validation?.contexts).toEqual(rendered.contexts);
    dismissPreparedTask(target, prepared!.id);
  });

  it("rejects the entire selection if one context fails", async () => {
    await expect(
      renderQuickActionSelection({
        action: action("{{ci.failures}}"),
        scope: scope(thread([])),
        choices,
        resolveContext: async (_environmentId, request) => {
          if (request.pullRequest?.number === 2) throw new Error("PR head changed");
          return contextFor(request);
        },
      }),
    ).rejects.toThrow("PR head changed");
  });

  it("enforces the size limit on the combined text", async () => {
    await expect(
      renderQuickActionSelection({
        action: action("{{ci.failures}}"),
        scope: scope(thread([])),
        choices,
        resolveContext: async (_environmentId, request) => {
          const context = contextFor(request);
          return {
            ...context,
            pullRequest: { ...context.pullRequest!, failures: "x".repeat(70_000) },
          };
        },
      }),
    ).rejects.toThrow("Select fewer targets");
  });
});
