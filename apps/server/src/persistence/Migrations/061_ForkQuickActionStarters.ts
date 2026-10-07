import { QuickAction } from "@t3tools/contracts";
import { QUICK_ACTION_STARTERS } from "@t3tools/shared/quickActions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Templates seeded by 059. A starter still carrying one of these was never edited,
// so it can move to the current text; any edited or deleted starter is left alone.
const SEEDED_TEMPLATES: Readonly<Record<string, string>> = {
  "99aa6720-f388-4bbd-aacc-000000000000":
    "Inspect the available CI failures. Explain the cause, make the smallest appropriate fix, and report the checks you ran. State what you could not verify. Do not commit, push, change branches, or open another thread unless I ask.",
  "99aa6720-f388-4bbd-aacc-000000000001":
    "Inspect the selected repository and available conflict information. Preserve both changes and unrelated local work. Do not start a merge/rebase, switch branches, commit, push, or open another thread without approval.",
  "99aa6720-f388-4bbd-aacc-000000000002":
    "Walk me through this pull request. Explain the behavior changes, important decisions, and risks. State any missing context.",
  "99aa6720-f388-4bbd-aacc-000000000003":
    "Review the current changes for correctness and reliability. Report concrete defects with file locations and user-visible effects. Do not modify files.",
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeEffect(Schema.fromJsonString(QuickAction));
  const encode = Schema.encodeEffect(Schema.fromJsonString(QuickAction));
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const starter of QUICK_ACTION_STARTERS) {
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM fork_quick_actions WHERE id = ${starter.id}`;
    const row = rows[0];
    if (!row) continue;
    const current = yield* decode(row.record_json);
    if (current.template !== SEEDED_TEMPLATES[starter.id]) continue;
    const record: QuickAction = {
      ...current,
      name: starter.name,
      description: starter.description,
      aliases: starter.aliases,
      tags: starter.tags,
      category: starter.category,
      template: starter.template,
      revision: current.revision + 1,
      updatedAt: now,
    };
    yield* sql`UPDATE fork_quick_actions SET record_json = ${yield* encode(record)}, revision = ${record.revision} WHERE id = ${starter.id}`;
  }
});
