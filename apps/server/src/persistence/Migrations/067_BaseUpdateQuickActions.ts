import { QuickAction } from "@t3tools/contracts";
import { BASE_UPDATE_STARTER_IDS, QUICK_ACTION_STARTERS } from "@t3tools/shared/quickActions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encode = Schema.encodeEffect(Schema.fromJsonString(QuickAction));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  // Fresh databases already received these starters in 059. Existing libraries receive only them.
  for (const starter of QUICK_ACTION_STARTERS) {
    if (!BASE_UPDATE_STARTER_IDS.has(starter.id)) continue;
    const json = yield* encode({ ...starter, revision: 1, createdAt: now, updatedAt: now });
    yield* sql`INSERT INTO fork_quick_actions (id, project_id, record_json, revision)
      VALUES (${starter.id}, ${starter.projectId}, ${json}, ${1}) ON CONFLICT (id) DO NOTHING`;
  }
});
