import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkspaceError,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Locks from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Repositories from "./WorkspaceRepositories.ts";
import * as Preparation from "./WorkspacePreparation.ts";
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider should start during workspace preparation"),
} as ProviderAdapterV2Shape;
const db = Sqlite.layerMemory;
const base = Layer.mergeAll(
  db,
  Projections.layer.pipe(Layer.provide(db)),
  Harness.layerWithRegistry(
    { name: "workspace-preparation" },
    Registry.layerFromAdapters([adapter]),
    { databaseLayer: db, runEffectWorker: false },
  ),
  Locks.layer,
  NodeCrypto.layer,
);
const threadId = ThreadId.make("workspace-thread");
const operationId = CommandId.make("prepare-workspace");
const manifest: ThreadWorkspace = {
  schemaVersion: 1,
  revision: 1,
  operationId,
  state: "planned",
  primaryBindingId: "api",
  bindings: ["api", "web"].map((id) => ({
    id,
    label: id,
    sourcePath: `/repos/${id}`,
    mode: "current",
    commonDir: `/repos/${id}/.git`,
    checkoutPath: `/repos/${id}`,
    branch: "main",
    head: "abc",
    baseCommit: "abc",
    state: "planned",
    owned: false,
    error: null,
  })),
};
const seed = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-workspace"),
    threadId,
    projectId: ProjectId.make("project-workspace"),
    title: "Workspace",
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const thread = yield* projections.getThread(threadId);
  const now = yield* DateTime.now;
  yield* events.write({
    events: [
      {
        id: EventId.make("workspace-plan"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: { ...thread, workspace: manifest },
      },
    ],
  });
});
it.effect("persists intent before preparation and retries only failed bindings", () =>
  Effect.gen(function* () {
    yield* seed;
    const projections = yield* Projections.ProjectionStoreV2;
    const calls: string[] = [];
    let fail = true;
    const repository = Layer.mock(Repositories.WorkspaceRepositories)({
      prepare: (binding) =>
        Effect.gen(function* () {
          const saved = (yield* projections.getThread(threadId).pipe(Effect.orDie)).workspace!;
          assert.equal(saved.bindings.find((entry) => entry.id === binding.id)?.state, "preparing");
          calls.push(binding.id);
          if (binding.id === "web" && fail)
            return yield* new WorkspaceError({ detail: "fixture failure" });
          return { ...binding, state: "ready" as const, error: null };
        }),
    });
    const prep = yield* Effect.service(Preparation.WorkspacePreparation).pipe(
      Effect.provide(Preparation.layer.pipe(Layer.provide(repository))),
    );
    yield* prep.execute(threadId, operationId);
    const failed = (yield* projections.getThread(threadId)).workspace!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.bindings[0]?.state, "ready");
    assert.equal(failed.bindings[1]?.error, "fixture failure");
    fail = false;
    yield* prep.execute(threadId, operationId);
    assert.deepEqual(calls, ["api", "web", "web"]);
    assert.equal((yield* projections.getThread(threadId)).workspace?.state, "ready");
    yield* prep.execute(threadId, operationId);
    assert.deepEqual(calls, ["api", "web", "web"]);
  }).pipe(Effect.provide(base)),
);
it.effect("cancellation stops later bindings without deleting the completed checkout", () =>
  Effect.gen(function* () {
    yield* seed;
    const events = yield* EventSink.EventSinkV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const calls: string[] = [];
    const repository = Layer.mock(Repositories.WorkspaceRepositories)({
      prepare: (binding) =>
        Effect.gen(function* () {
          calls.push(binding.id);
          const thread = yield* projections.getThread(threadId);
          const now = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make("cancel-workspace"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...thread, workspace: { ...thread.workspace!, state: "cancelled" } },
              },
            ],
          });
          return { ...binding, state: "ready" as const, error: null };
        }).pipe(Effect.orDie),
    });
    const prep = yield* Effect.service(Preparation.WorkspacePreparation).pipe(
      Effect.provide(Preparation.layer.pipe(Layer.provide(repository))),
    );
    yield* prep.execute(threadId, operationId);
    assert.deepEqual(calls, ["api"]);
    assert.equal((yield* projections.getThread(threadId)).workspace?.state, "cancelled");
  }).pipe(Effect.provide(base)),
);
it.effect("unlinking a repository's pull request leaves a tombstone a manual link restores", () =>
  Effect.gen(function* () {
    yield* seed;
    const engine = yield* Orchestrator.OrchestratorV2;
    const key = { host: "github.com", repository: "acme/web" };
    const link = (number: number, source: "created" | "manual", bindingId?: string) =>
      engine.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`link-${number}-${source}`),
        threadId,
        ...key,
        number,
        url: `https://github.com/acme/web/pull/${number}`,
        source,
        ...(bindingId === undefined ? {} : { bindingId }),
      });
    const unlink = (number: number) =>
      engine.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make(`unlink-${number}`),
        threadId,
        ...key,
        number,
      });
    const links = () =>
      engine.getThreadShell(threadId).pipe(
        Effect.map((thread) =>
          (thread?.pullRequests ?? []).map(({ number, source, bindingId }) => ({
            number,
            source,
            bindingId,
          })),
        ),
      );
    yield* link(1, "created", "web");
    yield* link(2, "manual");
    yield* unlink(1);
    yield* unlink(2);
    assert.deepEqual(yield* links(), [{ number: 1, source: "stack-dismissed", bindingId: "web" }]);
    yield* link(1, "manual");
    assert.deepEqual(yield* links(), [{ number: 1, source: "manual", bindingId: "web" }]);
  }).pipe(Effect.provide(base)),
);
