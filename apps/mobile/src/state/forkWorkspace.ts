import { createForkWorkspaceAtoms } from "@t3tools/client-runtime/state/forkWorkspace";
import { createQuickActionsEnvironmentAtoms } from "@t3tools/client-runtime/state/quickActions";
import { connectionAtomRuntime } from "../connection/runtime";
export const forkWorkspace = createForkWorkspaceAtoms(connectionAtomRuntime);
export const quickActionsEnvironment = createQuickActionsEnvironmentAtoms(connectionAtomRuntime);
