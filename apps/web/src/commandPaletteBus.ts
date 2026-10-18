import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";
import type {
  CommandPaletteFolderPick,
  CommandPaletteView,
} from "./components/CommandPalette.logic";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

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

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
