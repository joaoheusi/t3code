import { QuickAction } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { QUICK_ACTION_STARTERS } from "@t3tools/shared/quickActions";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fork_quick_actions (
    id TEXT PRIMARY KEY, project_id TEXT, record_json TEXT NOT NULL, revision INTEGER NOT NULL
  )`;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const action of QUICK_ACTION_STARTERS) {
    const record = { ...action, revision: 1, createdAt: now, updatedAt: now };
    yield* sql`INSERT INTO fork_quick_actions (id, project_id, record_json, revision)
      VALUES (${action.id}, ${action.projectId}, ${yield* Schema.encodeEffect(Schema.fromJsonString(QuickAction))(record)}, ${1})`;
  }
});
