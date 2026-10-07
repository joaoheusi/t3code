import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE fork_workspace_operations (
  operation_key TEXT PRIMARY KEY, request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed','uncertain')),
  result_json TEXT, updated_at TEXT NOT NULL
 )`;
});
