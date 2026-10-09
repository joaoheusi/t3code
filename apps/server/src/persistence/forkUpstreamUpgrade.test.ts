import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

it.effect("upgrades the installed fork without replaying its quick action migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 62 });
    yield* sql`UPDATE fork_quick_actions SET revision = 7, record_json = 'custom action'`;
    const actions = yield* sql`SELECT * FROM fork_quick_actions ORDER BY id`;
    assert.isAbove(actions.length, 0);
    const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

    assert.deepStrictEqual(yield* runMigrations(), [
      [63, "McpAppModelContext"],
      [64, "ThreadSnapshotWindowIndexes"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM fork_quick_actions ORDER BY id`, actions);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 62 ORDER BY migration_id`,
      history,
    );
    yield* sql`INSERT INTO mcp_app_model_context
      (thread_id, item_id, server, tool, text, updated_at)
      VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-08')`;
    assert.deepStrictEqual(yield* sql`SELECT text FROM mcp_app_model_context`, [
      { text: "context" },
    ]);
    const indexes = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'orchestration_v2_projection_turn_items_user_message_idx',
        'orchestration_v2_projection_nodes_live_idx'
      )`;
    assert.strictEqual(indexes.length, 2);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
