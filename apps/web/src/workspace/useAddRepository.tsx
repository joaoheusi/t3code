import type { EnvironmentId, ProjectId, WorkspaceRepository } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FolderGit2Icon, FolderOpenIcon, FolderSearchIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../components/CommandPalette.logic";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { useProjects, useServerConfigs } from "../state/entities";
import { forkWorkspace } from "../state/forkWorkspace";
import { useAtomCommand } from "../state/use-atom-command";
import { basename, draftRepositoryFrom } from "./workspaceModel";
import { useWorkspaceUiStore } from "./workspaceStores";

const parentFolder = (path: string) => path.replace(/[\\/][^\\/]+[\\/]?$/, "") || path;

/**
 * Picks another repository on the thread's machine. Projects there come first since
 * most second repositories already are one; any folder works, and a folder that is
 * not itself a repository is searched for repositories inside it.
 */
export function useAddRepository(input: {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly primaryRoot: string;
}) {
  const { draftKey, environmentId, projectId, primaryRoot } = input;
  const inspect = useAtomCommand(forkWorkspace.inspect, { reportFailure: false });
  const discover = useAtomCommand(forkWorkspace.discover, { reportFailure: false });
  // The "No project" scratch folder is a project too, but never a repository to add.
  const scratchRoot = useServerConfigs().get(environmentId)?.scratchWorkspaceRoot ?? null;
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      project.id !== projectId &&
      project.workspaceRoot !== scratchRoot,
  );

  const addRepository = useCallback(
    async (repository: WorkspaceRepository) => {
      const primary = await inspect({ environmentId, input: { path: primaryRoot } });
      if (primary._tag === "Success" && primary.value.commonDir === repository.commonDir) {
        toastManager.add({
          type: "info",
          title: `${basename(repository.path)} is this thread's own repository`,
          description: "Choose its checkout with the workspace and branch controls instead.",
        });
        return;
      }
      useWorkspaceUiStore
        .getState()
        .addDraftRepository(
          draftKey,
          { environmentId, projectId },
          draftRepositoryFrom(repository, randomUUID()),
        );
    },
    [draftKey, environmentId, inspect, primaryRoot, projectId],
  );

  const showDiscovered = useCallback(
    (root: string, repositories: readonly WorkspaceRepository[], limited: boolean) =>
      openCommandPalette({
        view: {
          addonIcon: <FolderSearchIcon className={ADDON_ICON_CLASS} />,
          groups: [
            {
              value: "discovered-repositories",
              label: `Repositories in ${basename(root)}${limited ? " (search stopped early)" : ""}`,
              items: repositories.map((repository): CommandPaletteActionItem => ({
                kind: "action",
                value: `repository:${repository.path}`,
                searchTerms: [repository.path, repository.branch ?? ""],
                title: basename(repository.path),
                description: `${repository.branch ?? "detached HEAD"}${repository.dirty ? " · uncommitted changes" : ""} · ${repository.path}`,
                icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
                run: () => addRepository(repository),
              })),
            },
          ],
        },
      }),
    [addRepository],
  );

  const addPath = useCallback(
    async (path: string) => {
      const inspected = await inspect({ environmentId, input: { path } });
      if (inspected._tag === "Success") {
        await addRepository(inspected.value);
        return;
      }
      const found = await discover({ environmentId, input: { root: path, depth: 3 } });
      if (found._tag === "Success" && found.value.repositories.length > 0) {
        showDiscovered(path, found.value.repositories, found.value.limited);
        return;
      }
      toastManager.add({
        type: "error",
        title: "No Git repository there",
        description:
          found._tag === "Failure"
            ? String(squashAtomCommandFailure(found))
            : `${path} isn't a Git repository and has none inside it.`,
      });
    },
    [addRepository, discover, environmentId, inspect, showDiscovered],
  );

  return useCallback(
    () =>
      openCommandPalette({
        view: {
          addonIcon: <FolderGit2Icon className={ADDON_ICON_CLASS} />,
          groups: [
            ...(projects.length > 0
              ? [
                  {
                    value: "repository-projects",
                    label: "Projects on this machine",
                    items: projects.map((project): CommandPaletteActionItem => ({
                      kind: "action",
                      value: `project:${project.id}`,
                      searchTerms: [project.title, project.workspaceRoot],
                      title: project.title,
                      description: project.workspaceRoot,
                      icon: <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />,
                      run: () => addPath(project.workspaceRoot),
                    })),
                  },
                ]
              : []),
            {
              value: "repository-folders",
              label: "Other folders",
              items: [
                {
                  kind: "action",
                  value: "browse-folder",
                  searchTerms: ["browse", "folder", "path", "disk", "find repositories"],
                  title: "Browse for a folder…",
                  description: "A repository, or a folder that contains repositories",
                  icon: <FolderOpenIcon className={ITEM_ICON_CLASS} />,
                  keepOpen: true,
                  run: async () =>
                    openCommandPalette({
                      pickFolder: {
                        environmentId,
                        initialPath: parentFolder(primaryRoot),
                        submitLabel: "Use folder",
                        onPick: (path) => void addPath(path),
                      },
                    }),
                },
              ],
            },
          ],
        },
      }),
    [addPath, environmentId, primaryRoot, projects],
  );
}
