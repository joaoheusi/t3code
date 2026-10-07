import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { QUICK_ACTION_STARTERS } from "@t3tools/shared/quickActions";
import migration from "../persistence/Migrations/059_ForkQuickActions.ts";
import starterUpgrade from "../persistence/Migrations/061_ForkQuickActionStarters.ts";
import * as QuickActions from "./QuickActions.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(migration).pipe(Layer.provideMerge(database));
const layer = QuickActions.layer.pipe(Layer.provideMerge(setup));
it.effect("persists edits, rejects stale saves, and does not recreate deleted starters", () =>
  Effect.gen(function* () {
    const library = yield* QuickActions.QuickActions;
    const starter = (yield* library.list())[0]!;
    const edited = yield* library.save({
      action: { ...starter, name: "My action" },
      expectedRevision: starter.revision,
    });
    assert.equal(edited.revision, 2);
    assert.equal(
      (yield* library.list()).find((action) => action.id === edited.id)?.name,
      "My action",
    );
    const stale = yield* library
      .save({ action: starter, expectedRevision: starter.revision })
      .pipe(Effect.flip);
    assert.equal(stale.code, "stale-revision");
    yield* library.remove({ id: edited.id, expectedRevision: edited.revision });
    assert.equal((yield* library.list()).length, QUICK_ACTION_STARTERS.length - 1);
  }).pipe(Effect.provide(layer)),
);
it.effect("rejects unknown variables and injection-shaped input is stored as text", () =>
  Effect.gen(function* () {
    const library = yield* QuickActions.QuickActions;
    const base = QUICK_ACTION_STARTERS[0]!;
    const invalid = yield* library
      .save({ action: { ...base, id: "invalid", template: "{{execute}}" }, expectedRevision: null })
      .pipe(Effect.flip);
    assert.equal(invalid.code, "invalid-template");
    yield* library.save({
      action: { ...base, id: "text", template: "'; DROP TABLE fork_quick_actions; --" },
      expectedRevision: null,
    });
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM fork_quick_actions`)[0]?.count,
      5,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("imports atomically and rolls back earlier records when any ID collides", () =>
  Effect.gen(function* () {
    const library = yield* QuickActions.QuickActions;
    const starter = (yield* library.list())[0]!;
    const failure = yield* library
      .importCopies({ actions: [{ ...starter, id: "new-copy" }, starter] })
      .pipe(Effect.flip);
    assert.equal(failure.code, "stale-revision");
    assert.equal(
      (yield* library.list()).some((action) => action.id === "new-copy"),
      false,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("upgrades only starters that still carry their seeded text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const library = yield* QuickActions.QuickActions;
    const [ci, conflicts] = yield* library.list();
    const seeded = {
      ...ci!,
      template:
        "Inspect the available CI failures. Explain the cause, make the smallest appropriate fix, and report the checks you ran. State what you could not verify. Do not commit, push, change branches, or open another thread unless I ask.",
    };
    const edited = { ...conflicts!, template: "My own conflict instruction" };
    for (const record of [seeded, edited]) {
      yield* sql`UPDATE fork_quick_actions SET record_json = ${JSON.stringify(record)} WHERE id = ${record.id}`;
    }
    yield* starterUpgrade;
    const upgraded = yield* library.list();
    assert.equal(upgraded[0]?.template, QUICK_ACTION_STARTERS[0]?.template);
    assert.equal(upgraded[0]?.revision, seeded.revision + 1);
    assert.equal(upgraded[1]?.template, "My own conflict instruction");
  }).pipe(Effect.provide(layer)),
);
