import { assert, it } from "@effect/vitest";
import { ThreadId, type GitRunStackedActionResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/060_ForkWorkspaceOperations.ts";
import * as Operations from "./WorkspaceOperations.ts";
const db = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = Operations.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(migration).pipe(Layer.provideMerge(db))),
);
const input = {
  threadId: ThreadId.make("thread"),
  bindingId: "api",
  expectedRevision: 1,
  actionId: "commit-1",
  action: "commit" as const,
};
const result: GitRunStackedActionResult = {
  action: "commit",
  branch: { status: "skipped_not_requested" },
  commit: { status: "created", commitSha: "abc" },
  push: { status: "skipped_not_requested" },
  pr: { status: "skipped_not_requested" },
  toast: { title: "Committed", cta: { kind: "none" } },
};
it.effect("records intent before Git and returns the stored result after a repeated request", () =>
  Effect.gen(function* () {
    const service = yield* Operations.WorkspaceOperations;
    const sql = yield* SqlClient.SqlClient;
    let calls = 0;
    const work = Effect.gen(function* () {
      const rows = yield* sql<{ state: string }>`SELECT state FROM fork_workspace_operations`;
      assert.equal(rows[0]?.state, "pending");
      calls++;
      return result;
    });
    assert.deepEqual(yield* service.run(input, work), result);
    assert.deepEqual(yield* service.run(input, work), result);
    assert.equal(calls, 1);
    const collision = yield* service.run({ ...input, action: "push" }, work).pipe(Effect.flip);
    assert.include(collision.message, "different request");
  }).pipe(Effect.provide(layer)),
);
it.effect("never replays a failed or interrupted Git write", () =>
  Effect.gen(function* () {
    const service = yield* Operations.WorkspaceOperations;
    let calls = 0;
    const work = Effect.sync(() => {
      calls++;
    }).pipe(Effect.andThen(Effect.fail("connection lost")));
    assert.equal(yield* service.run(input, work).pipe(Effect.flip), "connection lost");
    const repeated = yield* service.run(input, Effect.succeed(result)).pipe(Effect.flip);
    assert.include(repeated.message, "not replayed");
    assert.equal(calls, 1);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE fork_workspace_operations SET state='pending'`;
    const interrupted = yield* service.run(input, Effect.succeed(result)).pipe(Effect.flip);
    assert.include(interrupted.message, "unfinished");
  }).pipe(Effect.provide(layer)),
);
