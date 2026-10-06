import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createQuickActionsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "fork-actions:list",
      tag: WS_METHODS.quickActionsList,
      staleTimeMs: 0,
    }),
    reload: createEnvironmentRpcCommand(runtime, {
      label: "fork-actions:reload",
      tag: WS_METHODS.quickActionsList,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "fork-actions:save",
      tag: WS_METHODS.quickActionsSave,
    }),
    importCopies: createEnvironmentRpcCommand(runtime, {
      label: "fork-actions:import",
      tag: WS_METHODS.quickActionsImport,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "fork-actions:delete",
      tag: WS_METHODS.quickActionsDelete,
    }),
  };
}
