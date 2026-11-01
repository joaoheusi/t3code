import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  FOLDER_DISCOVERY_DEPTH,
  REPOSITORY_LIMIT,
  folderRepositoryChoice,
  topLevelRepositories,
} from "@t3tools/client-runtime/workspaceModel";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { forkWorkspace } from "../../state/forkWorkspace";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useMultiRepositoryVersion } from "../../workspace/useComposerRepositories";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

const NO_REPOSITORIES = [] as const;

/** A folder project's repositories, or null when the project is its own repository. */
export function useFolderRepositories(input: {
  readonly environmentId: EnvironmentId;
  readonly project: { readonly id: ProjectId; readonly workspaceRoot: string } | null;
  readonly chosen: readonly string[] | null;
}) {
  const { environmentId, project } = input;
  const supported = useMultiRepositoryVersion(environmentId) >= 3;
  const scratchRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot ?? null;
  const cwd = supported && project?.workspaceRoot !== scratchRoot ? project?.workspaceRoot : null;
  const refs = useEnvironmentQuery(
    cwd ? vcsEnvironment.listRefs({ environmentId, input: { cwd, limit: 1 } }) : null,
  );
  const folder = cwd && refs.data?.isRepo === false ? cwd : null;
  const discovery = useEnvironmentQuery(
    folder
      ? forkWorkspace.discoverQuery({
          environmentId,
          input: { root: folder, depth: FOLDER_DISCOVERY_DEPTH },
        })
      : null,
  );
  const saved = useEnvironmentSettings(environmentId, (settings) =>
    project
      ? (settings.projectSettingsOverrides[project.id]?.workspaceRepositories ?? NO_REPOSITORIES)
      : NO_REPOSITORIES,
  );
  if (!folder) return null;
  return {
    loading: discovery.isPending && discovery.data === null,
    error: discovery.data === null ? discovery.error : null,
    retry: discovery.refresh,
    choice: folderRepositoryChoice({
      found: topLevelRepositories(discovery.data?.repositories ?? []),
      saved,
      chosen: input.chosen,
    }),
  };
}

export function ScheduledTaskRepositoriesPicker(props: {
  readonly choice: ReturnType<typeof folderRepositoryChoice>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retry: () => void;
  readonly disabled: boolean;
  readonly onChange: (repositories: readonly string[]) => void;
}) {
  const { options, selected } = props.choice;
  if (props.error !== null && !props.loading)
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-destructive text-xs">
          Couldn't load this folder's repositories: {props.error}
        </p>
        <Button size="xs" variant="outline" onClick={props.retry}>
          Retry
        </Button>
      </div>
    );
  const atLimit = selected.length >= REPOSITORY_LIMIT;
  if (options.length === 0)
    return (
      <p className="text-muted-foreground text-xs">
        {props.loading
          ? "Looking for repositories…"
          : "This folder holds no repositories. Use the project checkout instead."}
      </p>
    );
  return (
    <div className="space-y-1.5">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map(({ path, label }) => (
          <label key={path} className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(path)}
              disabled={props.disabled || (atLimit && !selected.includes(path))}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked ? [...selected, path] : selected.filter((entry) => entry !== path),
                )
              }
            />
            <span className="truncate">{label}</span>
          </label>
        ))}
      </div>
      {atLimit ? (
        <p className="text-muted-foreground text-xs">
          A task can use up to {REPOSITORY_LIMIT} repositories.
        </p>
      ) : null}
    </div>
  );
}
