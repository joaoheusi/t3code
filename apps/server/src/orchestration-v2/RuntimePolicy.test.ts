import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly workspace?: ThreadWorkspace;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const museInstanceId = ProviderInstanceId.make("muse");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const driverKindByInstance = new Map<ProviderInstanceId, string>([
  [providerInstanceId, "codex"],
  [grokInstanceId, "grok"],
  [museInstanceId, "muse"],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    driverKind: ProviderDriverKind.make(driverKindByInstance.get(instanceId) ?? "codex"),
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mock(WorkspaceRepositories.WorkspaceRepositories)({
      validate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId,
          title: "Project",
          workspaceRoot: "/project-root",
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          pinnedAt: null,
          archivedAt: null,
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
);

const multiRepoWorkspace = {
  schemaVersion: 1,
  revision: 1,
  operationId: CommandId.make("op-multi-repo"),
  state: "ready",
  primaryBindingId: "web",
  bindings: [
    { id: "web", checkoutPath: "/org/web" },
    { id: "api", checkoutPath: "/org/api" },
  ].map((binding) => ({
    ...binding,
    label: binding.id,
    sourcePath: binding.checkoutPath,
    mode: "current" as const,
    commonDir: `${binding.checkoutPath}/.git`,
    branch: "main",
    head: "abc",
    baseCommit: "abc",
    state: "ready" as const,
    owned: false,
    error: null,
  })),
} satisfies ThreadWorkspace;

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect("grants Muse the extra checkouts of a multi-repository workspace", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null, workspace: multiRepoWorkspace }),
        modelSelection: { instanceId: museInstanceId, model: "muse-wonder-full-1.0" },
      });
      assert.equal(resolved.cwd, "/org/web");
      assert.deepStrictEqual(resolved.additionalDirectories, ["/org/api"]);
      assert.include(resolved.workspaceInstructions ?? "", "Validated workspace revision");
    }),
  );

  it.effect("still blocks an unverified driver on a multi-repository workspace", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({
          thread: makeThread({ now, worktreePath: null, workspace: multiRepoWorkspace }),
          modelSelection: { instanceId: grokInstanceId, model: "grok-4.7" },
        })
        .pipe(Effect.flip);
      assert.include(String(error.cause), "has not been verified for multi-repository access");
    }),
  );
});

it("starts folder threads in their folder and grants only checkouts outside it", () => {
  const binding = (id: string, checkoutPath: string) => ({
    id,
    label: id,
    sourcePath: checkoutPath,
    mode: "current" as const,
    commonDir: `${checkoutPath}/.git`,
    checkoutPath,
    branch: "main",
    head: "abc",
    baseCommit: "abc",
    state: "ready" as const,
    owned: false,
    error: null,
  });
  const workspace = {
    schemaVersion: 1 as const,
    revision: 1,
    operationId: CommandId.make("op"),
    state: "ready" as const,
    primaryBindingId: "web",
    bindings: [binding("web", "/org/web"), binding("api", "/org/api"), binding("x", "/org-x")],
  };
  assert.deepStrictEqual(RuntimePolicy.workspaceDirectories(workspace), {
    cwd: "/org/web",
    additionalDirectories: ["/org/api", "/org-x"],
  });
  assert.deepStrictEqual(
    RuntimePolicy.workspaceDirectories({
      ...workspace,
      root: { sourcePath: "/org", mode: "current", checkoutPath: "/org" },
    }),
    { cwd: "/org", additionalDirectories: ["/org-x"] },
  );
});
