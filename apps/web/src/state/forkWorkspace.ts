import { createForkWorkspaceAtoms } from "@t3tools/client-runtime/state/forkWorkspace";
import { connectionAtomRuntime } from "../connection/runtime";
export const forkWorkspace = createForkWorkspaceAtoms(connectionAtomRuntime);
