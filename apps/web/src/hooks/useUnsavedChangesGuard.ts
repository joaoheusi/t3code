import { useBlocker } from "@tanstack/react-router";
export function useUnsavedChangesGuard(dirty: boolean) {
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm("Discard unsaved changes?"),
    enableBeforeUnload: () => dirty,
  });
  return () => !dirty || window.confirm("Discard unsaved changes?");
}
