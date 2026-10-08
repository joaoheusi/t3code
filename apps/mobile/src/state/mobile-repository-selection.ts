import { WorkspaceRepositoryDefault } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MobileRepositorySelection = Schema.Struct({
  folder: Schema.Boolean,
  repositories: Schema.Array(
    Schema.Struct({
      ...WorkspaceRepositoryDefault.fields,
      branch: Schema.optional(Schema.NullOr(Schema.String)),
      head: Schema.optional(Schema.String),
    }),
  ),
});
export type MobileRepositorySelection = typeof MobileRepositorySelection.Type;
