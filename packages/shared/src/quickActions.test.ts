import { describe, expect, it } from "@effect/vitest";
import {
  exportPortableActions,
  importPortableActions,
  QUICK_ACTION_STARTERS,
  quickActionRequirements,
  rankQuickActions,
  renderQuickAction,
  validateQuickActionTemplate,
} from "./quickActions.ts";

const EXPORTED_AT = "2026-10-07T00:00:00.000Z";

describe("quick action templates", () => {
  it("substitutes once and preserves literal braces", () => {
    expect(
      renderQuickAction("{{clipboard}} \\{{date}} {{date}}", {
        clipboard: "{{time}} $HOME $(unsafe)",
        date: "today",
      }),
    ).toBe("{{time}} $HOME $(unsafe) {{date}} today");
  });
  it("rejects unknown and unavailable variables without inventing context", () => {
    expect(validateQuickActionTemplate("{{fetch('secret')}}")).toHaveLength(1);
    expect(() => renderQuickAction("{{repo.path}}", {})).toThrow("Choose or provide context");
  });
  it("bounds UTF-8 template and rendered text", () => {
    expect(validateQuickActionTemplate("😀".repeat(17000))).toHaveLength(1);
    expect(() => renderQuickAction("{{clipboard}}", { clipboard: "x".repeat(131073) })).toThrow(
      "128 KiB",
    );
  });
  it("round trips the complete standalone V1 field set", () => {
    const portable = QUICK_ACTION_STARTERS.filter(
      (action) => !quickActionRequirements(action.template).host,
    );
    const actions = importPortableActions(exportPortableActions(portable, EXPORTED_AT));
    expect(actions).toEqual(portable);
    expect(
      Object.keys(JSON.parse(exportPortableActions(actions, EXPORTED_AT)).actions[0]).sort(),
    ).toEqual(
      [
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
      ].sort(),
    );
  });
  it("rejects executable fields, shortcuts, duplicate IDs and fork-only exports", () => {
    const data = JSON.parse(exportPortableActions(QUICK_ACTION_STARTERS.slice(2), EXPORTED_AT));
    data.actions[0].shortcut = "cmd+g";
    expect(() => importPortableActions(JSON.stringify(data))).toThrow("extra fields");
    delete data.actions[0].shortcut;
    data.actions.push(data.actions[0]);
    expect(() => importPortableActions(JSON.stringify(data))).toThrow("duplicate ID");
    expect(() =>
      exportPortableActions(
        [{ ...QUICK_ACTION_STARTERS[0]!, template: "{{repo.path}}" }],
        EXPORTED_AT,
      ),
    ).toThrow("fork-only");
  });
  it("ranks names before aliases and uses favorite and recency to break ties", () => {
    const base = QUICK_ACTION_STARTERS[0]!;
    const items = [
      { ...base, id: "alias", name: "Other", aliases: ["resolve"] },
      { ...base, id: "prefix", name: "Resolve checks" },
      { ...base, id: "exact", name: "Resolve" },
      { ...base, id: "disabled", enabled: false, name: "Resolve" },
    ];
    expect(rankQuickActions(items, "resolve").map((item) => item.id)).toEqual([
      "exact",
      "prefix",
      "alias",
    ]);
  });
  it("requires every query word and keeps favorites behind better matches", () => {
    const base = QUICK_ACTION_STARTERS[0]!;
    const items = [
      { ...base, id: "ci", name: "Resolve CI", aliases: [], tags: ["ci"] },
      { ...base, id: "fav", name: "Rewrite clearly", favorite: true, aliases: [], tags: [] },
    ];
    expect(rankQuickActions(items, "res ci").map((item) => item.id)).toEqual(["ci"]);
    expect(rankQuickActions(items, "re").map((item) => item.id)).toEqual(["ci", "fav"]);
    expect(rankQuickActions(items, "").map((item) => item.id)).toEqual(["fav", "ci"]);
  });
  it("derives context needs from template variables", () => {
    expect(quickActionRequirements("{{date}} {{clipboard}}")).toMatchObject({
      clipboard: true,
      host: false,
    });
    expect(quickActionRequirements("Fix it\n\n{{pr.conflicts}}")).toMatchObject({
      host: true,
      pullRequest: true,
      repository: true,
      evidence: true,
    });
    expect(quickActionRequirements("\\{{ci.failures}}").host).toBe(false);
  });
});
