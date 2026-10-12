import { QuickAction } from "@t3tools/contracts";
import { QUICK_ACTION_STARTERS, QUICK_ACTION_STARTER_IDS } from "@t3tools/shared/quickActions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// The template 065 inserted. Review thread status now follows `{{pr.reviewThreads}}` instead of
// the starter's ID, so an unedited starter moves to the text that uses it. Edits are left alone.
const SEEDED_TEMPLATE =
  "Address the unresolved review threads on {{pr.url}} in this thread. Read each thread and check its feedback against the current code. Fix valid findings, run focused checks, and reply with what changed or a clear reason when no change is needed. Resolve threads only after their feedback has been addressed. Report anything still unresolved. Do not commit, push, merge, request another review, or open another thread unless I ask.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeEffect(Schema.fromJsonString(QuickAction));
  const encode = Schema.encodeEffect(Schema.fromJsonString(QuickAction));
  const id = QUICK_ACTION_STARTER_IDS.addressReviewThreads;
  const starter = QUICK_ACTION_STARTERS.find((action) => action.id === id)!;
  const rows = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM fork_quick_actions WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return;
  const decoded = yield* decode(row.record_json).pipe(Effect.option);
  if (Option.isNone(decoded) || decoded.value.template !== SEEDED_TEMPLATE) return;
  const current = decoded.value;
  const record: QuickAction = {
    ...current,
    template: starter.template,
    revision: current.revision + 1,
    updatedAt: DateTime.formatIso(yield* DateTime.now),
  };
  yield* sql`UPDATE fork_quick_actions SET record_json = ${yield* encode(record)}, revision = ${record.revision} WHERE id = ${id}`;
});
