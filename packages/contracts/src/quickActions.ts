import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const BoundedText = (max: number) => Schema.String.check(Schema.isMaxLength(max));
export const QuickActionId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
);
export const QuickActionFields = Schema.Struct({
  id: QuickActionId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: BoundedText(1024),
  aliases: Schema.Array(BoundedText(120)).check(Schema.isMaxLength(32)),
  tags: Schema.Array(BoundedText(120)).check(Schema.isMaxLength(32)),
  category: Schema.NullOr(BoundedText(120)),
  template: BoundedText(65536),
  projectId: Schema.NullOr(ProjectId),
  enabled: Schema.Boolean,
  favorite: Schema.Boolean,
});
export type QuickActionFields = typeof QuickActionFields.Type;
export const QuickAction = Schema.Struct({
  ...QuickActionFields.fields,
  revision: NonNegativeInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type QuickAction = typeof QuickAction.Type;
export const QuickActionsListInput = Schema.Struct({ projectId: Schema.optionalKey(ProjectId) });
export const QuickActionSaveInput = Schema.Struct({
  action: QuickActionFields,
  expectedRevision: Schema.NullOr(NonNegativeInt),
});
export type QuickActionSaveInput = typeof QuickActionSaveInput.Type;
export const QuickActionDeleteInput = Schema.Struct({
  id: QuickActionId,
  expectedRevision: NonNegativeInt,
});
export type QuickActionDeleteInput = typeof QuickActionDeleteInput.Type;
export class QuickActionError extends Schema.TaggedError<QuickActionError>()("QuickActionError", {
  code: Schema.Literals([
    "stale-revision",
    "invalid-template",
    "storage",
    "missing-project",
    "limit",
  ]),
}) {
  override get message() {
    switch (this.code) {
      case "stale-revision":
        return "The action changed or was deleted. Reload the library before saving.";
      case "invalid-template":
        return "The template contains an unknown variable or exceeds the text limit.";
      case "missing-project":
        return "The project is unavailable on this environment.";
      case "limit":
        return "This environment already has 1,000 quick actions.";
      case "storage":
        return "The action library could not be read or saved.";
    }
  }
}

export const QuickActionImportInput = Schema.Struct({
  actions: Schema.Array(QuickActionFields).check(Schema.isMaxLength(1000)),
});
export type QuickActionImportInput = typeof QuickActionImportInput.Type;
