import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { resolveBranchTriggerLabel, sanitizeNewRefName } from "./BranchToolbar.logic";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Button } from "./ui/button";
import { ComposerControl, ComposerControlChevron } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComboboxTrigger } from "./ui/combobox";

export function WorktreeBaseBranchPicker({
  environmentId,
  cwd,
  value,
  onValueChange,
  startFromOrigin,
  onStartFromOriginChange,
  disabled = false,
  id,
  compact = false,
  placeholder,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  value: string;
  onValueChange: (branch: string) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** A small trigger matching the composer's branch control, for rows in a list. */
  compact?: boolean;
  /** Shown before a branch is chosen, when no branch still means something. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const branches = usePaginatedBranches({
    environmentId,
    cwd,
    query: sanitizeNewRefName(deferredQuery),
  });
  const selectedRefQuery = useEnvironmentQuery(
    cwd && value
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: value, limit: 10 },
        })
      : null,
  );
  const selectedRef =
    branches.refs.find((branch) => branch.name === value) ??
    selectedRefQuery.data?.refs.find((branch) => branch.name === value);
  const label =
    !value && placeholder
      ? placeholder
      : resolveBranchTriggerLabel({
          activeWorktreePath: null,
          effectiveEnvMode: "worktree",
          resolvedActiveBranch: value || null,
          resolvedActiveBranchIsRemote: selectedRef ? selectedRef.isRemote === true : null,
          startFromOrigin,
        });
  const branchByName = new Map(branches.refs.map((branch) => [branch.name, branch]));
  const items = [...branchByName.keys()];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText =
    branches.error ??
    (branches.isPending && branches.data === null
      ? "Loading refs..."
      : branches.isFetchingNextPage
        ? "Loading more refs..."
        : hasNextPage
          ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} refs`
          : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={value || null}
      query={query}
      onQueryChange={setQuery}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      onSelectItem={(name) => {
        onValueChange(name);
        handleOpenChange(false);
      }}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={statusText}
      originControl={{ checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }}
      popupProps={{ align: "start", side: "bottom", className: "flex w-80 flex-col" }}
      renderItem={(name, index) => {
        const branch = branchByName.get(name);
        return branch ? (
          <BranchPickerRefItem
            branch={branch}
            projectCwd={cwd}
            index={index}
            onClick={() => {
              onValueChange(branch.name);
              handleOpenChange(false);
            }}
          />
        ) : null;
      }}
    >
      {compact ? (
        <ComboboxTrigger
          id={id}
          disabled={disabled || !cwd}
          render={<ComposerControl size="xs" />}
          className="min-w-0 max-w-full active:scale-100"
        >
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <ComposerContextLabel>
            <MiddleTruncate value={label} className="w-full" />
          </ComposerContextLabel>
          <ComposerControlChevron size="xs" />
        </ComboboxTrigger>
      ) : (
        <ComboboxTrigger
          id={id}
          disabled={disabled || !cwd}
          render={<Button variant="outline" size="sm" />}
          className="w-full justify-between "
        >
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <MiddleTruncate value={label} className="flex-1 text-left" />
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </ComboboxTrigger>
      )}
    </BranchPicker>
  );
}
