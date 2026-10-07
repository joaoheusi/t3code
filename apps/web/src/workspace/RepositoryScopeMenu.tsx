import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, FolderGit2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/menu";
import { useThreadShell } from "../state/entities";
import { useActiveRepository } from "./ThreadRepositoriesSection";
import { useWorkspaceUiStore } from "./workspaceStores";

/** Switches which repository a right-panel view shows. Renders nothing for single-repository threads. */
export function RepositoryScopeMenu(props: { threadRef: ScopedThreadRef | null }) {
  const workspace = useThreadShell(props.threadRef)?.workspace;
  const active = useActiveRepository(props.threadRef);
  if (!props.threadRef || !workspace || !active) return null;
  const threadKey = scopedThreadKey(props.threadRef);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant="secondary" />}
        className="max-w-48 shrink-0"
        aria-label={`Repository: ${active.label}`}
      >
        <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{active.label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={active.id}
          onValueChange={(bindingId) =>
            useWorkspaceUiStore.getState().setActiveRepository(threadKey, String(bindingId))
          }
        >
          {workspace.bindings.map((binding) => (
            <DropdownMenuRadioItem key={binding.id} value={binding.id} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{binding.label}</span>
                <span className="ms-auto truncate text-muted-foreground text-xs">
                  {binding.branch ?? "detached HEAD"}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
