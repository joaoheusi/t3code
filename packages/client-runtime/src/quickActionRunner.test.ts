import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type QuickAction } from "@t3tools/contracts";
import {
  describeQuickActionTargets,
  renderQuickActionSelection,
  type QuickActionVariant,
} from "./quickActionRunner";

const action: QuickAction = {
  id: "paste",
  name: "Paste",
  description: "",
  aliases: [],
  tags: [],
  category: null,
  template: "{{date}} {{clipboard}}",
  projectId: null,
  enabled: true,
  favorite: false,
  revision: 1,
  createdAt: "",
  updatedAt: "",
};
const input = {
  action,
  scope: {
    environmentId: EnvironmentId.make("host"),
    projectId: ProjectId.make("project"),
    thread: null,
  },
  choices: [{}],
  now: new Date(2026, 9, 8, 12, 0),
  resolveContext: async () => {
    throw new Error("Should not request host context");
  },
};
describe("quick actions across clients", () => {
  it("uses the supplied device clipboard without depending on browser globals", async () => {
    const rendered = await renderQuickActionSelection({
      ...input,
      readClipboard: async () => "phone clipboard",
    });
    expect(rendered.text).toBe("2026-10-08 phone clipboard");
    expect(rendered.contexts).toEqual([]);
  });
  it("does not silently insert an action with a missing clipboard value", async () => {
    await expect(
      renderQuickActionSelection({ ...input, readClipboard: async () => "" }),
    ).rejects.toThrow("clipboard is empty");
  });
});

describe("quick action target summaries", () => {
  const variant = (
    number: number,
    snapshot: Partial<NonNullable<QuickActionVariant["snapshot"]>> | null,
    bindingId?: string,
  ): QuickActionVariant => ({
    key: `${number}|${bindingId ?? ""}`,
    label: `#${number}`,
    choice: {
      ...(bindingId ? { bindingId } : {}),
      pullRequest: { host: "github.com", repository: "acme/app", number },
    },
    snapshot: snapshot as QuickActionVariant["snapshot"],
  });
  const fixCi = { template: "Fix {{ci.failures}}" };

  it("counts each pull request once and says how many need the action", () => {
    expect(
      describeQuickActionTargets(fixCi, [
        variant(1, { checksState: "failing" }, "a"),
        variant(1, { checksState: "failing" }, "b"),
        variant(2, { checksState: "passing" }),
        variant(3, { checksState: "failing" }),
      ]),
    ).toBe("2 of 3 pull requests need this");
  });
  it("falls back to the target count when a pull request is not synced", () => {
    expect(
      describeQuickActionTargets(fixCi, [variant(1, { checksState: "failing" }), variant(2, null)]),
    ).toBe("2 pull requests");
  });
  it("only counts targets for actions that do not read CI or conflicts", () => {
    expect(
      describeQuickActionTargets({ template: "Review {{pr.url}}" }, [
        variant(1, { checksState: "failing" }),
      ]),
    ).toBe("1 pull request");
  });
});
