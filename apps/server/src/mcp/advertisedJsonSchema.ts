import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

const tagOf = (branch: JsonObject, key: string): ReadonlyArray<Json> | undefined => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length > 0
    ? property.enum
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.flatMap((object) => tagOf(object, key) ?? [undefined]);
    return (
      objects.every((object) => tagOf(object, key) !== undefined) &&
      new Set(values.map((value) => JSON.stringify(value))).size === values.length
    );
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.flatMap((object) => tagOf(object, tag) ?? []) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

/** Bare `{type}` branches collapse to one type list; some model APIs cap schema nesting depth. */
const mergeTypeBranches = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  const types: string[] = [];
  for (const branch of branches) {
    if (!Predicate.isObject(branch) || Object.keys(branch).length !== 1) return undefined;
    const list = Array.isArray(branch.type) ? branch.type : [branch.type];
    for (const type of list) {
      if (typeof type !== "string") return undefined;
      if (!types.includes(type)) types.push(type);
    }
  }
  return types.length > 0 ? { type: types.length === 1 ? types[0]! : types } : undefined;
};

const compact = (schema: Json, optional: boolean): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name)),
            ]),
          )
        : compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only =
      branches.length === 1
        ? branches[0]
        : (mergeTypeBranches(branches) ?? mergeTaggedObjects(branches));
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

/**
 * The input schema T3 advertises for a tool: the full schema minus noise every thread pays for.
 * Unions flatten (tagged objects merge, bare types list) to stay under model API nesting caps.
 * Decoding still uses the full schema, so each tag's own required fields still apply.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false) as ReturnType<typeof Tool.getJsonSchema>;
