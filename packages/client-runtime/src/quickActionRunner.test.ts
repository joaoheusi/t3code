import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type QuickAction } from "@t3tools/contracts";
import { renderQuickActionSelection } from "./quickActionRunner";

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
