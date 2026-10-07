import {
  GitRunStackedActionResult,
  WorkspaceError,
  WorkspaceGitActionInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(WorkspaceGitActionInput));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(GitRunStackedActionResult));
const decodeResult = Schema.decodeEffect(Schema.fromJsonString(GitRunStackedActionResult));

/** Persist intent before Git. An interrupted write requires inspection, never automatic replay. */
export class WorkspaceOperations extends Context.Service<
  WorkspaceOperations,
  {
    readonly run: <E>(
      input: typeof WorkspaceGitActionInput.Type,
      operation: Effect.Effect<GitRunStackedActionResult, E>,
    ) => Effect.Effect<GitRunStackedActionResult, E | WorkspaceError>;
  }
>()("t3/workspace/WorkspaceOperations") {}
export const layer = Layer.effect(
  WorkspaceOperations,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storeError = () =>
      new WorkspaceError({
        detail:
          "The Git operation receipt could not be read or saved. Inspect the selected repository before trying another operation.",
      });
    return WorkspaceOperations.of({
      run: (input, operation) =>
        Effect.gen(function* () {
          const key = yield* encodeKey([input.threadId, input.bindingId, input.actionId]).pipe(
            Effect.mapError(storeError),
          );
          const request = yield* encodeRequest(input).pipe(Effect.mapError(storeError));
          const now = DateTime.formatIso(yield* DateTime.now);
          const claimed = yield* sql<{
            operation_key: string;
          }>`INSERT INTO fork_workspace_operations(operation_key,request_json,state,updated_at) VALUES(${key},${request},'pending',${now}) ON CONFLICT(operation_key) DO NOTHING RETURNING operation_key`.pipe(
            Effect.mapError(storeError),
          );
          if (claimed.length === 0) {
            const rows = yield* sql<{
              request_json: string;
              state: string;
              result_json: string | null;
            }>`SELECT request_json,state,result_json FROM fork_workspace_operations WHERE operation_key=${key}`.pipe(
              Effect.mapError(storeError),
            );
            const receipt = rows[0];
            if (receipt?.request_json !== request)
              return yield* new WorkspaceError({
                detail: "This operation ID was already used for a different request.",
              });
            if (receipt.state !== "completed" || receipt.result_json === null)
              return yield* new WorkspaceError({
                detail:
                  "This Git operation has an uncertain or unfinished result. Inspect the repository and remote before explicitly starting a new operation. It was not replayed.",
              });
            return yield* decodeResult(receipt.result_json).pipe(Effect.mapError(storeError));
          }
          const result = yield* operation.pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* sql`UPDATE fork_workspace_operations SET state='uncertain',updated_at=${now} WHERE operation_key=${key}`.pipe(
              Effect.mapError(storeError),
            );
            return yield* Effect.fail(result.failure);
          }
          const encoded = yield* encodeResult(result.success).pipe(Effect.mapError(storeError));
          yield* sql`UPDATE fork_workspace_operations SET state='completed',result_json=${encoded},updated_at=${now} WHERE operation_key=${key}`.pipe(
            Effect.mapError(storeError),
          );
          return result.success;
        }),
    });
  }),
);
