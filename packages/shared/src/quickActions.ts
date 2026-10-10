import type { QuickActionFields } from "@t3tools/contracts";
import { scoreQueryMatch } from "./searchRanking.ts";

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
  "pr.conflicts",
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

/**
 * What a template needs before it can render. Client values come from this
 * device; everything else is read from the thread's environment.
 */
export interface QuickActionRequirements {
  readonly clipboard: boolean;
  readonly host: boolean;
  readonly thread: boolean;
  readonly pullRequest: boolean;
  readonly repository: boolean;
  /** CI or conflict evidence; inserted as a separate block after the draft. */
  readonly evidence: boolean;
}
export function quickActionRequirements(template: string): QuickActionRequirements {
  const used = new Set(templateVariables(template));
  const any = (...names: QuickActionVariable[]) => names.some((name) => used.has(name));
  return {
    clipboard: used.has("clipboard"),
    host: any(
      "thread.title",
      "workspace.repositories",
      "repo.name",
      "repo.path",
      "repo.branch",
      "pr.url",
      "ci.failures",
      "pr.conflicts",
    ),
    thread: used.has("thread.title"),
    pullRequest: any("pr.url", "ci.failures", "pr.conflicts"),
    // Local conflict state belongs to one checkout, so conflicts need a repository too.
    repository: any("repo.name", "repo.path", "repo.branch", "pr.conflicts"),
    evidence: any("ci.failures", "pr.conflicts"),
  };
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

function scoreQuickActionToken<T extends QuickActionFields>(action: T, token: string) {
  const fields = [
    [action.name, 0],
    ...action.aliases.map((alias) => [alias, 200] as const),
    ...action.tags.map((tag) => [tag, 400] as const),
    [action.category ?? "", 600],
  ] as const;
  const scores = fields.flatMap(([value, offset]) => {
    const score = scoreQueryMatch({
      value: value.toLocaleLowerCase(),
      query: token,
      exactBase: offset,
      prefixBase: offset + 10,
      boundaryBase: offset + 30,
      includesBase: offset + 60,
      fuzzyBase: offset + 120,
    });
    return score === null ? [] : [score];
  });
  return scores.length ? Math.min(...scores) : null;
}

/**
 * Every query word must match a name, alias, tag, or category. Names rank
 * above aliases, aliases above tags. Favorites and recent use only break ties.
 */
export function rankQuickActions<T extends QuickActionFields>(
  actions: readonly T[],
  search: string,
  recent: readonly string[] = [],
): T[] {
  const tokens = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const recency = (action: T) => {
    const index = recent.indexOf(action.id);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return (
    actions
      .flatMap((action) => {
        if (!action.enabled) return [];
        let score = 0;
        for (const token of tokens) {
          const tokenScore = scoreQuickActionToken(action, token);
          if (tokenScore === null) return [];
          score += tokenScore;
        }
        return [{ action, score }];
      })
      // flatMap already returned a fresh array, so sorting it in place is safe.
      .sort(
        (a, b) =>
          a.score - b.score ||
          Number(b.action.favorite) - Number(a.action.favorite) ||
          recency(a.action) - recency(b.action) ||
          a.action.name.localeCompare(b.action.name) ||
          a.action.id.localeCompare(b.action.id),
      )
      .map((entry) => entry.action)
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
  exportedAt: string,
): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt,
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

/** Starter IDs are stable so the PR buttons can find the user's edited instruction. */
export const QUICK_ACTION_STARTER_IDS = {
  resolveCi: "99aa6720-f388-4bbd-aacc-000000000000",
  resolveConflicts: "99aa6720-f388-4bbd-aacc-000000000001",
  pullRequestWalkthrough: "99aa6720-f388-4bbd-aacc-000000000002",
  reviewChanges: "99aa6720-f388-4bbd-aacc-000000000003",
  addressReviewThreads: "99aa6720-f388-4bbd-aacc-000000000004",
} as const;

const starter = (
  fields: Pick<QuickActionFields, "id" | "name" | "description" | "template"> &
    Partial<Pick<QuickActionFields, "aliases" | "tags" | "category">>,
): QuickActionFields => ({
  aliases: [],
  tags: [],
  category: null,
  projectId: null,
  favorite: false,
  enabled: true,
  ...fields,
});

export const QUICK_ACTION_STARTERS: readonly QuickActionFields[] = [
  starter({
    id: QUICK_ACTION_STARTER_IDS.resolveCi,
    name: "Resolve CI",
    description: "Fix the failing checks on this thread's pull request",
    aliases: ["fix ci", "fix checks"],
    tags: ["ci"],
    category: "Pull requests",
    template:
      "Inspect the CI failures below for the selected repository and commit. Explain the cause, make the smallest appropriate fix, and report the checks you ran. State what you could not verify. Do not commit, push, change branches, or open another thread unless I ask.\n\n{{ci.failures}}",
  }),
  starter({
    id: QUICK_ACTION_STARTER_IDS.resolveConflicts,
    name: "Resolve merge conflicts",
    description: "Resolve conflicts while keeping the intent of both sides",
    aliases: ["fix conflicts"],
    tags: ["git"],
    category: "Pull requests",
    template:
      "Inspect the selected repository and the conflict information below. Preserve the intent of both changes and unrelated local work. Explain any decision that needs my input. Do not start a merge or rebase, switch branches, commit, push, or open another thread without my approval.\n\n{{pr.conflicts}}",
  }),
  starter({
    id: QUICK_ACTION_STARTER_IDS.pullRequestWalkthrough,
    name: "PR walkthrough",
    description: "Explain the pull request's behavior changes and risks",
    aliases: ["explain pr"],
    tags: ["review"],
    category: "Pull requests",
    template:
      "Walk me through this pull request. Explain the behavior before and after the change, important decisions, and risks. State any missing context.",
  }),
  starter({
    id: QUICK_ACTION_STARTER_IDS.reviewChanges,
    name: "Review changes",
    description: "Find defects in the current changes without editing files",
    aliases: ["code review"],
    tags: ["review"],
    category: "Review",
    template:
      "Review the current changes for correctness and reliability. Report concrete defects with file locations and user-visible effects. Do not modify files.",
  }),
  starter({
    id: QUICK_ACTION_STARTER_IDS.addressReviewThreads,
    name: "Address review threads",
    description: "Check PR review feedback, fix valid findings, and resolve addressed threads",
    aliases: ["address reviews", "fix review comments", "resolve review threads"],
    tags: ["review", "pr"],
    category: "Pull requests",
    template:
      "Address the unresolved review threads on {{pr.url}} in this thread. Read each thread and check its feedback against the current code. Fix valid findings, run focused checks, and reply with what changed or a clear reason when no change is needed. Resolve threads only after their feedback has been addressed. Report anything still unresolved. Do not commit, push, merge, request another review, or open another thread unless I ask.",
  }),
];

const STARTER_ORDER = new Map<string, number>(
  [
    QUICK_ACTION_STARTER_IDS.resolveConflicts,
    QUICK_ACTION_STARTER_IDS.resolveCi,
    QUICK_ACTION_STARTER_IDS.addressReviewThreads,
    QUICK_ACTION_STARTER_IDS.pullRequestWalkthrough,
    QUICK_ACTION_STARTER_IDS.reviewChanges,
  ].map((id, index) => [id, index]),
);

/** Fixed starter order in quick-action menus; typed searches retain relevance ranking. */
export function rankQuickActionMenu<T extends QuickActionFields>(
  actions: readonly T[],
  search: string,
  recent: readonly string[] = [],
): T[] {
  const ranked = rankQuickActions(actions, search, recent);
  return search.trim()
    ? ranked
    : ranked.sort(
        (a, b) =>
          (STARTER_ORDER.get(a.id) ?? STARTER_ORDER.size) -
          (STARTER_ORDER.get(b.id) ?? STARTER_ORDER.size),
      );
}
