import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import { advertisedJsonSchema } from "../advertisedJsonSchema.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";

// Meta's API rejects tool schemas nested beyond 10 levels; keep two levels of margin for wrappers.
const MAX_SCHEMA_DEPTH = 8;

const schemaDepth = (value: unknown): number => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  let deepest = 0;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "properties" &&
      typeof child === "object" &&
      child !== null &&
      !Array.isArray(child)
    )
      deepest = Math.max(deepest, ...Object.values(child).map(schemaDepth));
    else if (key === "items" || key === "additionalProperties" || key === "not")
      deepest = Math.max(deepest, schemaDepth(child));
    else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(child))
      deepest = Math.max(deepest, ...child.map(schemaDepth));
  }
  return 1 + deepest;
};

it("keeps every advertised MCP tool schema under provider nesting limits", () => {
  const toolkits = {
    AttachmentToolkit,
    DeviceToolkit,
    EnvironmentToolkit,
    HtmlToolkit,
    OrchestratorToolkit,
    PreviewToolkit,
    PreviewControlsToolkit,
    ProjectToolkit,
    PullRequestsToolkit,
    ThreadToolkit,
    WorktreeToolkit,
  };
  const tooDeep: string[] = [];
  for (const toolkit of Object.values(toolkits)) {
    for (const tool of Object.values(toolkit.tools)) {
      const depth = schemaDepth(advertisedJsonSchema(tool));
      if (depth > MAX_SCHEMA_DEPTH) tooDeep.push(`${tool.name}: ${depth}`);
    }
  }
  expect(tooDeep).toEqual([]);
});
