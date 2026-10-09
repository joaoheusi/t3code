import { QuickAction } from "@t3tools/contracts";
import { QUICK_ACTION_STARTERS, QUICK_ACTION_STARTER_IDS } from "@t3tools/shared/quickActions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encode = Schema.encodeEffect(Schema.fromJsonString(QuickAction));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const starter = QUICK_ACTION_STARTERS.find(
    (action) => action.id === QUICK_ACTION_STARTER_IDS.addressReviewThreads,
  )!;
  const now = DateTime.formatIso(yield* DateTime.now);
  const record = { ...starter, revision: 1, createdAt: now, updatedAt: now };
  const json = yield* encode(record);
  // Fresh databases already received this starter in 059. Existing libraries receive only it.
  yield* sql`INSERT INTO fork_quick_actions (id, project_id, record_json, revision)
    VALUES (${starter.id}, ${starter.projectId}, ${json}, ${1}) ON CONFLICT (id) DO NOTHING`;
});
