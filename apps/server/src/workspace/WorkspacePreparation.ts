import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import {
  EventId,
  type CommandId,
  type ThreadId,
  type ThreadWorkspace,
  WorkspaceError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WorkspaceRepositories from "./WorkspaceRepositories.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
export class WorkspacePreparation extends Context.Service<
  WorkspacePreparation,
  {
    readonly execute: (
      threadId: ThreadId,
      operationId: CommandId,
    ) => Effect.Effect<void, WorkspaceError>;
  }
>()("t3/workspace/WorkspacePreparation") {}
const make = Effect.gen(function* () {
  const repositories = yield* WorkspaceRepositories.WorkspaceRepositories;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const read = (threadId: ThreadId) =>
    projections
      .getThread(threadId)
      .pipe(
        Effect.mapError(
          () => new WorkspaceError({ detail: "The workspace thread is unavailable." }),
        ),
      );
  const update = (
    threadId: ThreadId,
    operationId: CommandId,
    transform: (workspace: ThreadWorkspace) => ThreadWorkspace,
  ) =>
    commands.withLock(
      threadId,
      Effect.gen(function* () {
        const thread = yield* read(threadId);
        if (
          !thread.workspace ||
          thread.workspace.operationId !== operationId ||
          thread.workspace.state === "cancelled" ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null
        )
          return false;
        const workspace = transform(thread.workspace);
        const now = yield* DateTime.now;
        yield* events
          .write({
            events: [
              {
                id: EventId.make(yield* randomUuidV4),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: { ...thread, workspace, updatedAt: now },
              },
            ],
          })
          .pipe(
            Effect.mapError(
              () => new WorkspaceError({ detail: "The workspace state could not be committed." }),
            ),
          );
        return true;
      }),
    );
  const execute: WorkspacePreparation["Service"]["execute"] = Effect.fn(
    "WorkspacePreparation.execute",
  )(function* (threadId, operationId) {
    const initial = (yield* read(threadId)).workspace;
    if (
      !initial ||
      initial.operationId !== operationId ||
      initial.state === "ready" ||
      initial.state === "cancelled"
    )
      return;
    if (
      !(yield* update(threadId, operationId, (workspace) => ({
        ...workspace,
        state: "validating",
      })))
    )
      return;
    for (const binding of initial.bindings) {
      const current = yield* read(threadId);
      if (
        current.workspace?.operationId !== operationId ||
        current.workspace.state === "cancelled" ||
        current.deletedAt !== null ||
        current.archivedAt !== null
      )
        return;
      const latest = current.workspace.bindings.find((entry) => entry.id === binding.id)!;
      if (latest.state === "ready") continue;
      if (
        !(yield* update(threadId, operationId, (workspace) => ({
          ...workspace,
          state: "preparing",
          bindings: workspace.bindings.map((entry) =>
            entry.id === latest.id ? { ...entry, state: "preparing", error: null } : entry,
          ),
        })))
      )
        return;
      const outcome = yield* repositories.prepare(latest, operationId).pipe(Effect.result);
      yield* update(threadId, operationId, (workspace) => ({
        ...workspace,
        bindings: workspace.bindings.map((entry) =>
          entry.id !== latest.id
            ? entry
            : outcome._tag === "Success"
              ? outcome.success
              : { ...entry, state: "failed", error: outcome.failure.message },
        ),
      }));
    }
    yield* update(threadId, operationId, (workspace) => ({
      ...workspace,
      state: workspace.bindings.every((binding) => binding.state === "ready") ? "ready" : "failed",
    }));
  });
  return WorkspacePreparation.of({ execute });
});
export const layer = Layer.effect(WorkspacePreparation, make);
