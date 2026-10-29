import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";
import type {
  CommandPaletteFolderPick,
  CommandPaletteView,
} from "./components/CommandPalette.logic";

import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in" | "quick-actions";
  /** With `open: "quick-actions"`, jump straight to this action's targets. */
  readonly actionId?: string;
  /** A one-off choice another surface needs, such as which thread receives a task. */
  readonly view?: CommandPaletteView;
  /** Like `view`, but stacked on the current palette view so Back returns to it. */
  readonly pushView?: CommandPaletteView;
  /** Browse folders on an environment and hand the chosen path back. */
  readonly pickFolder?: CommandPaletteFolderPick;
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
}

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.pushView) {
    dispatchCommandPalette({ _tag: "PushView", view: detail.pushView });
  } else if (detail.view) {
    dispatchCommandPalette({ _tag: "OpenView", view: detail.view });
  } else if (detail.pickFolder) {
    dispatchCommandPalette({ _tag: "PickFolder", request: detail.pickFolder });
  } else if (detail.open === "quick-actions") {
    dispatchCommandPalette({
      _tag: "OpenQuickActions",
      ...(detail.actionId ? { actionId: detail.actionId } : {}),
    });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({ _tag: "OpenAddProject" });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
