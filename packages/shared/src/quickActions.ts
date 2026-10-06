import type { QuickActionFields } from "@t3tools/contracts";

export const QUICK_ACTION_VARIABLES = [
  "date",
  "time",
  "clipboard",
  "thread.title",
  "workspace.repositories",
  "repo.name",
  "repo.path",
  "repo.branch",
  "pr.url",
  "ci.failures",
] as const;
export type QuickActionVariable = (typeof QUICK_ACTION_VARIABLES)[number];
const variableNames = new Set<string>(QUICK_ACTION_VARIABLES);
const tokenPattern = /\\\{\{([^{}]+)\}\}|\{\{([^{}]+)\}\}/g;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** A backslash before the opening braces makes a literal: \{{date}}. */
export function templateVariables(template: string): string[] {
  return [...template.matchAll(tokenPattern)].flatMap((match) =>
    match[2] ? [match[2].trim()] : [],
  );
}
export function validateQuickActionTemplate(template: string): string[] {
  const errors = templateVariables(template)
    .filter((name) => !variableNames.has(name))
    .map((name) => `Unknown variable: {{${name}}}`);
  if (byteLength(template) > 65536) errors.push("Templates are limited to 64 KiB.");
  return [...new Set(errors)];
}
export function renderQuickAction(
  template: string,
  values: Partial<Record<QuickActionVariable, string>>,
): string {
  const errors = validateQuickActionTemplate(template);
  if (errors.length) throw new Error(errors.join("\n"));
  const rendered = template.replace(
    tokenPattern,
    (_token, escaped: string | undefined, name: string | undefined) => {
      if (escaped !== undefined) return `{{${escaped}}}`;
      const key = name!.trim() as QuickActionVariable;
      const value = values[key];
      if (value === undefined) throw new Error(`Choose or provide context for {{${key}}}.`);
      return value;
    },
  );
  if (byteLength(rendered) > 131072)
    throw new Error("Rendered actions are limited to 128 KiB. Reduce the template or context.");
  return rendered;
}

export function rankQuickActions<T extends QuickActionFields>(
  actions: readonly T[],
  search: string,
  recent: readonly string[] = [],
): T[] {
  const query = search.trim().toLocaleLowerCase();
  const score = (action: T) => {
    const name = action.name.toLocaleLowerCase();
    if (!query) return 1;
    if (name === query) return 5;
    if (name.startsWith(query)) return 4;
    if (name.includes(query)) return 3;
    if (
      [...action.aliases, ...action.tags, action.category ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(query),
      )
    )
      return 2;
    return 0;
  };
  return actions
    .filter((action) => action.enabled && score(action) > 0)
    .toSorted(
      (a, b) =>
        score(b) - score(a) ||
        Number(b.favorite) - Number(a.favorite) ||
        (recent.indexOf(a.id) < 0 ? Infinity : recent.indexOf(a.id)) -
          (recent.indexOf(b.id) < 0 ? Infinity : recent.indexOf(b.id)) ||
        a.name.localeCompare(b.name),
    );
}

const portableKeys = [
  "id",
  "name",
  "description",
  "aliases",
  "category",
  "tags",
  "template",
  "deliveryMode",
  "favorite",
  "enabled",
];
export function importPortableActions(json: string): QuickActionFields[] {
  if (byteLength(json) > 2 * 1024 * 1024) throw new Error("Imports are limited to 2 MiB.");
  const data: unknown = JSON.parse(json);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Expected a portable action envelope.");
  const envelope = data as Record<string, unknown>;
  if (
    Object.keys(envelope).some(
      (key) => !["schemaVersion", "exportedAt", "actions"].includes(key),
    ) ||
    envelope.schemaVersion !== 1 ||
    typeof envelope.exportedAt !== "string" ||
    !Array.isArray(envelope.actions) ||
    envelope.actions.length > 1000
  )
    throw new Error("Unsupported portable action format.");
  const ids = new Set<string>();
  return envelope.actions.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid action.");
    const action = value as Record<string, unknown>;
    if (
      Object.keys(action).length !== portableKeys.length ||
      portableKeys.some((key) => !(key in action)) ||
      Object.keys(action).some((key) => !portableKeys.includes(key))
    )
      throw new Error("Portable actions cannot contain shortcuts, builders, or extra fields.");
    const {
      id,
      name,
      description,
      aliases,
      category,
      tags,
      template,
      deliveryMode,
      favorite,
      enabled,
    } = action;
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 120 ||
      typeof description !== "string" ||
      description.length > 1024 ||
      !Array.isArray(aliases) ||
      aliases.length > 32 ||
      aliases.some((v) => typeof v !== "string" || v.length > 120) ||
      !Array.isArray(tags) ||
      tags.length > 32 ||
      tags.some((v) => typeof v !== "string" || v.length > 120) ||
      !(category === null || (typeof category === "string" && category.length <= 120)) ||
      typeof template !== "string" ||
      validateQuickActionTemplate(template).length ||
      !["copy", "paste", "inherit"].includes(String(deliveryMode)) ||
      typeof favorite !== "boolean" ||
      typeof enabled !== "boolean"
    )
      throw new Error("An imported action is invalid or has a duplicate ID.");
    ids.add(id);
    return {
      id,
      name: name.trim(),
      description,
      aliases: aliases as string[],
      category,
      tags: tags as string[],
      template,
      favorite,
      enabled,
      projectId: null,
    };
  });
}
export function exportPortableActions(
  actions: readonly QuickActionFields[],
  instant = new Date(),
): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: instant.toISOString(),
      actions: actions.map((action) => {
        if (
          templateVariables(action.template).some(
            (name) => !["date", "time", "clipboard"].includes(name),
          )
        )
          throw new Error(`Edit fork-only variables in “${action.name}” before portable export.`);
        const { id, name, description, aliases, category, tags, template, favorite, enabled } =
          action;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
          throw new Error(
            "Portable actions require UUID IDs. Duplicate this action before exporting.",
          );
        return {
          id,
          name,
          description,
          aliases,
          category,
          tags,
          template,
          deliveryMode: "copy",
          favorite,
          enabled,
        };
      }),
    },
    null,
    2,
  );
}

export const QUICK_ACTION_STARTERS: readonly QuickActionFields[] = [
  [
    "99aa6720-f388-4bbd-aacc-000000000000",
    "Resolve CI",
    "Inspect the available CI failures. Explain the cause, make the smallest appropriate fix, and report the checks you ran. State what you could not verify. Do not commit, push, change branches, or open another thread unless I ask.",
  ],
  [
    "99aa6720-f388-4bbd-aacc-000000000001",
    "Resolve merge conflicts",
    "Inspect the selected repository and available conflict information. Preserve both changes and unrelated local work. Do not start a merge/rebase, switch branches, commit, push, or open another thread without approval.",
  ],
  [
    "99aa6720-f388-4bbd-aacc-000000000002",
    "PR walkthrough",
    "Walk me through this pull request. Explain the behavior changes, important decisions, and risks. State any missing context.",
  ],
  [
    "99aa6720-f388-4bbd-aacc-000000000003",
    "Review changes",
    "Review the current changes for correctness and reliability. Report concrete defects with file locations and user-visible effects. Do not modify files.",
  ],
].map(([id, name, template]) => ({
  id: id!,
  name: name!,
  template: template!,
  description: "Editable starter instruction",
  aliases: [],
  tags: [],
  category: null,
  projectId: null,
  favorite: false,
  enabled: true,
}));
