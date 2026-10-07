import { WorkspaceError, type ThreadWorkspace } from "@t3tools/contracts";

/** Drawer reopen, attach and restart must preserve a terminal's repository identity. */
export function resolveWorkspaceTerminal(workspace: ThreadWorkspace, terminalId: string) {
  const id = terminalId.startsWith("repo:") ? terminalId.split(":")[1] : workspace.primaryBindingId;
  const binding = workspace.bindings.find((entry) => entry.id === id);
  if (!binding || binding.state !== "ready" || workspace.state !== "ready") {
    throw new WorkspaceError({
      detail:
        "This terminal's repository is unavailable. Prepare the workspace and open a repository terminal again.",
    });
  }
  return binding;
}
