import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// 060's receipts backed the per-repository Git action RPC, which was removed with the
// rest of the fork's standalone repository UI. Nothing reads them anymore.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS fork_workspace_operations`;
});
