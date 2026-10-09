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
  describeQuickActionTargets,
  quickActionTargets,
  recentQuickActionIds,
  type QuickActionScope,
  type QuickActionVariant,
} from "./quickActionRunner";
import { useQuickActionGit } from "./useQuickActionGit";
import { useQuickActionMerge } from "./useQuickActionMerge";
import { QuickActionPullRequestStatus } from "./QuickActionPullRequestStatus";
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

function targetDescription(variant: QuickActionVariant, scope: QuickActionScope) {
  return variant.choice.pullRequest && scope.projectId ? (
    <QuickActionPullRequestStatus
      environmentId={scope.environmentId}
      reference={{ ...variant.choice.pullRequest, projectId: scope.projectId }}
      snapshot={variant.snapshot ?? null}
    />
  ) : undefined;
}

function targetItems(
  variants: readonly QuickActionVariant[],
  prefix: string,
  name: string,
  scope: QuickActionScope,
  run: (variant: QuickActionVariant) => Promise<void>,
): CommandPaletteActionItem[] {
  return variants.map((variant) => ({
    kind: "action",
    value: `${prefix}:${variant.key}`,
    searchTerms: [variant.label ?? name, variant.choice.pullRequest?.repository ?? ""],
    title: variant.label ?? name,
    description: targetDescription(variant, scope),
    icon: variant.choice.pullRequest ? (
      <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />
    ) : (
      <FolderGit2Icon className={ITEM_ICON_CLASS} />
    ),
    run: () => run(variant),
  }));
}

/**
 * Palette entries for the composer the palette was opened over. An action that
 * could target several PRs or repositories opens a submenu instead of guessing.
 */
export function useQuickActionPalette(input: {
  readonly target: ComposerThreadTarget | null;
  readonly scope: QuickActionScope | null;
  readonly gitCwd: string | null;
  readonly onClose: () => void;
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
  const prepareMerge = useQuickActionMerge();
  const git = useQuickActionGit(scope, input.gitCwd, input.onClose);

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
        description: only.choice.pullRequest ? (
          <span className="flex items-center gap-2">
            <span>{only.label}</span>
            {targetDescription(only, scope)}
          </span>
        ) : (
          action.description || undefined
        ),
        run: () => run({ action, choice: only.choice, scope, target }),
      };
    }
    return {
      ...base,
      kind: "submenu",
      description:
        describeQuickActionTargets(action, targets.variants) ??
        (action.description || "Choose where it applies"),
      addonIcon: <ZapIcon className={ADDON_ICON_CLASS} />,
      multiSelect: {
        actionLabel: "Insert selected",
        run: (values) =>
          run({
            action,
            choices: targets.variants
              .filter((variant) => values.includes(`quick-action:${action.id}:${variant.key}`))
              .map((variant) => variant.choice),
            scope: scope!,
            target: target!,
          }),
      },
      groups: [
        {
          value: `quick-action-targets:${action.id}`,
          label: action.name,
          items: targetItems(
            targets.variants,
            `quick-action:${action.id}`,
            action.name,
            scope!,
            (variant) => run({ action, choice: variant.choice, scope: scope!, target: target! }),
          ),
        },
      ],
    };
  };

  const items: QuickActionPaletteItem[] = [
    ...git.items,
    ...rankQuickActions(library.actions, "", recentQuickActionIds()).map(itemFor),
  ];
  if (scope?.projectId && scope.thread) {
    const mergeTargets = quickActionTargets({ template: "{{pr.url}}" }, scope);
    const projectId = scope.projectId;
    const mergeBase = {
      value: "quick-action:merge",
      title: "Merge pull requests",
      searchTerms: ["merge", "pull requests", "squash", "rebase"],
      icon: <PullRequestGlyph.merged className={ITEM_ICON_CLASS} />,
    };
    if (mergeTargets.kind === "ready") {
      const prepare = (variants: readonly QuickActionVariant[]) =>
        prepareMerge(
          scope.environmentId,
          variants.flatMap((variant) =>
            variant.choice.pullRequest ? [{ ...variant.choice.pullRequest, projectId }] : [],
          ),
        );
      const [only] = mergeTargets.variants;
      if (mergeTargets.variants.length === 1 && only) {
        items.push({
          ...mergeBase,
          kind: "action",
          title: `Merge ${only.label ?? "pull request"}`,
          description: targetDescription(only, scope),
          keepOpen: true,
          run: () => prepare([only]),
        });
      } else
        items.push({
          ...mergeBase,
          kind: "submenu",
          description: "Choose pull requests to merge",
          addonIcon: <PullRequestGlyph.merged className={ADDON_ICON_CLASS} />,
          multiSelect: {
            actionLabel: "Continue",
            keepOpen: true,
            run: (values) =>
              prepare(
                mergeTargets.variants.filter((variant) =>
                  values.includes(`quick-action:merge:${variant.key}`),
                ),
              ),
          },
          groups: [
            {
              value: "quick-action-targets:merge",
              label: "Merge pull requests",
              items: targetItems(
                mergeTargets.variants,
                "quick-action:merge",
                "Merge pull requests",
                scope,
                (variant) => prepare([variant]),
              ),
            },
          ],
        });
    } else {
      items.push({
        ...mergeBase,
        kind: "action",
        description: mergeTargets.reason,
        disabled: true,
        run: async () => {},
      });
    }
  }
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
    dialog: git.dialog,
    supported: library.supported,
    isPending: library.isPending,
    /** Matching actions join root search results without crowding the empty palette. */
    searchItems: items,
    groups,
    findItem: (actionId: string) => items.find((item) => item.value === `quick-action:${actionId}`),
  };
}
