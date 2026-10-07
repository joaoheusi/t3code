import { createQuickActionsEnvironmentAtoms } from "@t3tools/client-runtime/state/quickActions";
import { connectionAtomRuntime } from "../connection/runtime";
export const quickActionsEnvironment = createQuickActionsEnvironmentAtoms(connectionAtomRuntime);
