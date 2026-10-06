import { describe, expect, it } from "vitest";
import {
  exportPortableActions,
  importPortableActions,
  QUICK_ACTION_STARTERS,
  rankQuickActions,
  renderQuickAction,
  validateQuickActionTemplate,
} from "./quickActions.ts";

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
    const actions = importPortableActions(exportPortableActions(QUICK_ACTION_STARTERS));
    expect(actions).toEqual(QUICK_ACTION_STARTERS);
    expect(Object.keys(JSON.parse(exportPortableActions(actions)).actions[0]).sort()).toEqual(
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
    const data = JSON.parse(exportPortableActions(QUICK_ACTION_STARTERS));
    data.actions[0].shortcut = "cmd+g";
    expect(() => importPortableActions(JSON.stringify(data))).toThrow("extra fields");
    delete data.actions[0].shortcut;
    data.actions.push(data.actions[0]);
    expect(() => importPortableActions(JSON.stringify(data))).toThrow("duplicate ID");
    expect(() =>
      exportPortableActions([{ ...QUICK_ACTION_STARTERS[0]!, template: "{{repo.path}}" }]),
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
});
