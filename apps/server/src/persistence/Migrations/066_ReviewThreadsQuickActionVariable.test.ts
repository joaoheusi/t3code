import { assert, it } from "@effect/vitest";
import { QUICK_ACTION_STARTER_IDS } from "@t3tools/shared/quickActions";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));
const id = QUICK_ACTION_STARTER_IDS.addressReviewThreads;
const seeded =
  "Address the unresolved review threads on {{pr.url}} in this thread. Read each thread and check its feedback against the current code. Fix valid findings, run focused checks, and reply with what changed or a clear reason when no change is needed. Resolve threads only after their feedback has been addressed. Report anything still unresolved. Do not commit, push, merge, request another review, or open another thread unless I ask.";

const setTemplate = (template: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM fork_quick_actions WHERE id = ${id}`;
    const record = { ...JSON.parse(row!.record_json), template };
    yield* sql`UPDATE fork_quick_actions SET record_json = ${JSON.stringify(record)} WHERE id = ${id}`;
  });
const readStarter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    record_json: string;
    revision: number;
  }>`SELECT record_json, revision FROM fork_quick_actions WHERE id = ${id}`;
  return { template: JSON.parse(row!.record_json).template as string, revision: row!.revision };
});

layer("066_ReviewThreadsQuickActionVariable", (it) => {
  it.effect("moves only an unedited review threads starter to the review threads variable", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* setTemplate(seeded);
      yield* runMigrations({ toMigrationInclusive: 66 });
      const updated = yield* readStarter;
      assert.include(updated.template, "{{pr.reviewThreads}}");
      assert.equal(updated.revision, 2);
    }),
  );
});

layer("066_ReviewThreadsQuickActionVariable edited", (it) => {
  it.effect("leaves an edited starter alone", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* setTemplate("My own review instructions");
      yield* runMigrations({ toMigrationInclusive: 66 });
      assert.deepEqual(yield* readStarter, {
        template: "My own review instructions",
        revision: 1,
      });
    }),
  );
});
