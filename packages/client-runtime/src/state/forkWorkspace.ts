import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
export function createForkWorkspaceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    context: createEnvironmentRpcCommand(runtime, {
      label: "fork-actions:context",
      tag: WS_METHODS.actionContext,
    }),
    inspect: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:inspect",
      tag: WS_METHODS.workspaceInspect,
    }),
    discover: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:discover",
      tag: WS_METHODS.workspaceDiscover,
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-workspace:status",
      tag: WS_METHODS.workspaceStatus,
      staleTimeMs: 0,
    }),
    diff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-workspace:diff",
      tag: WS_METHODS.workspaceDiff,
      staleTimeMs: 0,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:write-file",
      tag: WS_METHODS.workspaceWriteFile,
    }),
    search: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:search",
      tag: WS_METHODS.workspaceSearch,
    }),
    readFile: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:read-file",
      tag: WS_METHODS.workspaceReadFile,
    }),
    terminal: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:terminal",
      tag: WS_METHODS.workspaceTerminal,
    }),
    gitAction: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:git-action",
      tag: WS_METHODS.workspaceGitAction,
    }),
  };
}
