import type { KeybindingCommand, QuickAction } from "@t3tools/contracts";
import { rankQuickActions } from "@t3tools/shared/quickActions";
import { FolderGit2Icon, PlusIcon, SettingsIcon, ZapIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "../components/CommandPalette.logic";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import type { ComposerThreadTarget } from "../composerDraftStore";
import {
  quickActionTargets,
  recentQuickActionIds,
  type QuickActionScope,
} from "./quickActionRunner";
import { useQuickActionLibrary, useRunQuickAction } from "./useQuickActions";

const QUICK_ACTIONS_GROUP = "quick-actions";
const LIBRARY_GROUP = "quick-actions-library";
/** The palette keeps this view live while the library loads; other submenus are snapshots. */
export const isQuickActionsView = (groups: readonly CommandPaletteGroup[]) =>
  groups.some((group) => group.value === LIBRARY_GROUP);
/** Opens Settings → Quick actions with a new-action editor. */
export const NEW_QUICK_ACTION_HASH = "new-quick-action";
export const quickActionCommand = (id: string) => `quickAction.${id}.insert` as KeybindingCommand;
export const quickActionIdFromCommand = (command: string) =>
  /^quickAction\.(.+)\.insert$/.exec(command)?.[1] ?? null;

type QuickActionPaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

/**
 * Palette entries for the composer the palette was opened over. An action that
 * could target several PRs or repositories opens a submenu instead of guessing.
 */
export function useQuickActionPalette(input: {
  readonly target: ComposerThreadTarget | null;
  readonly scope: QuickActionScope | null;
  readonly onManage: () => Promise<void>;
  readonly onCreate: () => Promise<void>;
}) {
  const { target, scope } = input;
  const library = useQuickActionLibrary(
    scope?.environmentId ?? null,
    scope?.projectId ?? null,
    true,
  );
  const { run } = useRunQuickAction();

  const itemFor = (action: QuickAction): QuickActionPaletteItem => {
    const base = {
      value: `quick-action:${action.id}`,
      searchTerms: [
        action.name,
        ...action.aliases,
        ...action.tags,
        action.category ?? "",
        "quick action",
      ],
      title: action.name,
      icon: <ZapIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: quickActionCommand(action.id),
    };
    const targets =
      target && scope
        ? quickActionTargets(action, scope)
        : ({ kind: "unavailable", reason: "Open a thread to insert it" } as const);
    if (targets.kind === "unavailable") {
      return {
        ...base,
        kind: "action",
        description: targets.reason,
        disabled: true,
        run: async () => {},
      };
    }
    const [only] = targets.variants;
    if (targets.variants.length === 1 && only && target && scope) {
      return {
        ...base,
        kind: "action",
        ...(action.description ? { description: action.description } : {}),
        run: () => run({ action, choice: only.choice, scope, target }),
      };
    }
    return {
      ...base,
      kind: "submenu",
      description: action.description || "Choose where it applies",
      addonIcon: <ZapIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: `quick-action-targets:${action.id}`,
          label: action.name,
          items: targets.variants.map((variant) => ({
            kind: "action",
            value: `quick-action:${action.id}:${variant.key}`,
            searchTerms: [variant.label ?? action.name],
            title: variant.label ?? action.name,
            icon: variant.choice.pullRequest ? (
              <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />
            ) : (
              <FolderGit2Icon className={ITEM_ICON_CLASS} />
            ),
            run: () => run({ action, choice: variant.choice, scope: scope!, target: target! }),
          })),
        },
      ],
    };
  };

  const items = rankQuickActions(library.actions, "", recentQuickActionIds()).map(itemFor);
  const libraryItems: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "quick-actions:new",
      searchTerms: ["new quick action", "create", "add"],
      title: "New quick action",
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: input.onCreate,
    },
    {
      kind: "action",
      value: "quick-actions:manage",
      searchTerms: ["manage quick actions", "edit", "settings", "import", "export"],
      title: "Manage quick actions",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: input.onManage,
    },
  ];
  const groups: CommandPaletteGroup[] = [
    ...(items.length > 0
      ? [{ value: QUICK_ACTIONS_GROUP, label: "Quick actions", items }]
      : library.isPending
        ? [
            {
              value: QUICK_ACTIONS_GROUP,
              label: "Quick actions",
              items: [
                {
                  kind: "action" as const,
                  value: "quick-actions:loading",
                  searchTerms: [],
                  title: "Loading quick actions…",
                  icon: <ZapIcon className={ITEM_ICON_CLASS} />,
                  disabled: true,
                  run: async () => {},
                },
              ],
            },
          ]
        : []),
    { value: LIBRARY_GROUP, label: "Library", items: libraryItems },
  ];

  return {
    supported: library.supported,
    isPending: library.isPending,
    /** Matching actions join root search results without crowding the empty palette. */
    searchItems: items,
    groups,
    findItem: (actionId: string) => items.find((item) => item.value === `quick-action:${actionId}`),
  };
}
