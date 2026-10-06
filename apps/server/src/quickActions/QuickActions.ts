import * as DateTime from "effect/DateTime";
import {
  QuickAction,
  QuickActionError,
  QuickActionSaveInput,
  QuickActionImportInput,
  type QuickActionDeleteInput,
  type ProjectId,
} from "@t3tools/contracts";
import { validateQuickActionTemplate } from "@t3tools/shared/quickActions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class QuickActions extends Context.Service<
  QuickActions,
  {
    readonly list: (
      projectId?: ProjectId,
    ) => Effect.Effect<readonly QuickAction[], QuickActionError>;
    readonly save: (input: QuickActionSaveInput) => Effect.Effect<QuickAction, QuickActionError>;
    readonly importCopies: (
      input: QuickActionImportInput,
    ) => Effect.Effect<readonly QuickAction[], QuickActionError>;
    readonly remove: (input: QuickActionDeleteInput) => Effect.Effect<void, QuickActionError>;
  }
>()("t3/quickActions/QuickActions") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeEffect(Schema.fromJsonString(QuickAction));
  const storageError = () => new QuickActionError({ code: "storage" });
  const list: QuickActions["Service"]["list"] = (projectId) =>
    (projectId === undefined
      ? sql<{ record_json: string }>`SELECT record_json FROM fork_quick_actions ORDER BY id`
      : sql<{
          record_json: string;
        }>`SELECT record_json FROM fork_quick_actions WHERE project_id IS NULL OR project_id = ${projectId} ORDER BY id`
    ).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.record_json))),
      Effect.mapError(storageError),
    );
  const save: QuickActions["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const { action, expectedRevision } = yield* Schema.decodeEffect(QuickActionSaveInput)(
        input,
      ).pipe(Effect.mapError(() => new QuickActionError({ code: "invalid-template" })));
      if (validateQuickActionTemplate(action.template).length)
        return yield* new QuickActionError({ code: "invalid-template" });
      if (action.projectId !== null) {
        const projects =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${action.projectId} AND deleted_at IS NULL`.pipe(
            Effect.mapError(storageError),
          );
        if (!projects.length) return yield* new QuickActionError({ code: "missing-project" });
      }
      const rows = yield* sql<{
        record_json: string;
        revision: number;
      }>`SELECT record_json, revision FROM fork_quick_actions WHERE id = ${action.id}`.pipe(
        Effect.mapError(storageError),
      );
      const row = rows[0];
      if ((row?.revision ?? null) !== expectedRevision)
        return yield* new QuickActionError({ code: "stale-revision" });
      if (!row) {
        const counts = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM fork_quick_actions`.pipe(Effect.mapError(storageError));
        if ((counts[0]?.count ?? 1000) >= 1000)
          return yield* new QuickActionError({ code: "limit" });
      }
      const previous = row
        ? yield* decode(row.record_json).pipe(Effect.mapError(storageError))
        : null;
      const now = DateTime.formatIso(yield* DateTime.now);
      const record: QuickAction = {
        ...action,
        revision: (row?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      yield* sql`INSERT INTO fork_quick_actions (id, project_id, record_json, revision)
      VALUES (${record.id}, ${record.projectId}, ${yield* Schema.encodeEffect(Schema.fromJsonString(QuickAction))(record).pipe(Effect.mapError(() => new QuickActionError({ code: "storage" })))}, ${record.revision})
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, record_json = excluded.record_json, revision = excluded.revision`.pipe(
        Effect.mapError(storageError),
      );
      return record;
    }).pipe(
      sql.withTransaction,
      Effect.mapError((error) => (Schema.is(QuickActionError)(error) ? error : storageError())),
    );
  const remove: QuickActions["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      const rows =
        yield* sql`DELETE FROM fork_quick_actions WHERE id = ${input.id} AND revision = ${input.expectedRevision} RETURNING id`.pipe(
          Effect.mapError(storageError),
        );
      if (!rows.length) return yield* new QuickActionError({ code: "stale-revision" });
    });
  const importCopies: QuickActions["Service"]["importCopies"] = (input) =>
    Effect.gen(function* () {
      const validated = yield* Schema.decodeEffect(QuickActionImportInput)(input).pipe(
        Effect.mapError(() => new QuickActionError({ code: "invalid-template" })),
      );
      const ids = new Set(validated.actions.map((action) => action.id));
      if (ids.size !== validated.actions.length)
        return yield* new QuickActionError({ code: "stale-revision" });
      return yield* Effect.forEach(
        validated.actions,
        (action) => save({ action, expectedRevision: null }),
        { concurrency: 1 },
      );
    }).pipe(
      sql.withTransaction,
      Effect.mapError((error) => (Schema.is(QuickActionError)(error) ? error : storageError())),
    );
  return QuickActions.of({ list, save, remove, importCopies });
});
export const layer = Layer.effect(QuickActions, make);
