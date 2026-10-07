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
    /** The repositories inside a folder project, cached so each new draft doesn't walk the folder again. */
    discoverQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-workspace:discover-query",
      tag: WS_METHODS.workspaceDiscover,
      staleTimeMs: 60_000,
    }),
    terminal: createEnvironmentRpcCommand(runtime, {
      label: "fork-workspace:terminal",
      tag: WS_METHODS.workspaceTerminal,
    }),
  };
}
