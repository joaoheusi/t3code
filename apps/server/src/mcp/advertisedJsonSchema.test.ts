import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { type: ["string", "null"] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("merges tagged unions whose tag enums hold several disjoint values", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      filter: Schema.Union([
        Schema.Struct({
          op: Schema.Literals(["equals", "startsWith"]),
          value: Schema.String,
        }),
        Schema.Struct({ op: Schema.Literal("in"), value: Schema.Array(Schema.String) }),
        Schema.Struct({ op: Schema.Literal("exists") }),
      ]),
      setting: Schema.Union([Schema.String, Schema.Boolean]),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["equals", "startsWith", "in", "exists"] },
          value: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        },
        required: ["op"],
      },
      setting: { type: ["string", "boolean"] },
    },
    required: ["filter", "setting"],
  });
});
