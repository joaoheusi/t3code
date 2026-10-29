import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  KeybindingCommand,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestRef,
  QuickAction,
} from "@t3tools/contracts";
import {
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
  pullRequestSnapshotMergeState,
  quickActionMergeKind,
  type QuickActionMergeKind,
} from "@t3tools/client-runtime/pullRequestActions";
import {
  pullRequestKnownState,
  pullRequestTargetKey,
  type PullRequestKnownState,
} from "@t3tools/client-runtime/quickActionRunner";
import { rankQuickActionMenu } from "@t3tools/shared/quickActions";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
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
import { pullRequestEnvironment } from "../state/pullRequests";
import {
  describeQuickActionTargets,
  quickActionSignals,
  quickActionTargets,
  recentQuickActionIds,
  type QuickActionScope,
  type QuickActionSignal,
  type QuickActionVariant,
} from "./quickActionRunner";
import { useQuickActionGit } from "./useQuickActionGit";
import { useQuickActionMerge } from "./useQuickActionMerge";
import { QuickActionPullRequestStatus } from "./QuickActionPullRequestStatus";
import { useQuickActionLibrary, useRunQuickAction } from "./useQuickActions";

const QUICK_ACTIONS_GROUP = "quick-actions";
export const LIBRARY_GROUP = "quick-actions-library";
/** The palette keeps this view live while the library loads; other submenus are snapshots. */
export const isQuickActionsView = (groups: readonly CommandPaletteGroup[]) =>
  groups.some((group) => group.value === LIBRARY_GROUP);
/** Opens Settings → Quick actions with a new-action editor. */
export const NEW_QUICK_ACTION_HASH = "new-quick-action";
export const quickActionCommand = (id: string) => `quickAction.${id}.insert` as KeybindingCommand;
export const quickActionIdFromCommand = (command: string) =>
  /^quickAction\.(.+)\.insert$/.exec(command)?.[1] ?? null;

type QuickActionPaletteItem = CommandPaletteActionItem | CommandPaletteSubmenuItem;

/** Merging depends on both CI and conflicts. */
const MERGE_SIGNALS: readonly QuickActionSignal[] = ["ci", "conflicts"];

function targetDescription(
  variant: QuickActionVariant,
  scope: QuickActionScope,
  signals: readonly QuickActionSignal[],
) {
  return variant.choice.pullRequest && scope.projectId && signals.length > 0 ? (
    <QuickActionPullRequestStatus
      environmentId={scope.environmentId}
      reference={{ ...variant.choice.pullRequest, projectId: scope.projectId }}
      snapshot={variant.snapshot ?? null}
      signals={signals}
    />
  ) : undefined;
}

/** How a merge target starts, or why it cannot. */
interface MergeTarget {
  readonly kind: QuickActionMergeKind | null;
  readonly blocker: string | null;
  /** Decided from fresh details rather than the synced snapshot. */
  readonly fresh: boolean;
}

function targetItems(
  variants: readonly QuickActionVariant[],
  prefix: string,
  name: string,
  scope: QuickActionScope,
  signals: readonly QuickActionSignal[],
  run: (variant: QuickActionVariant) => Promise<void>,
  mergeTargets?: readonly MergeTarget[],
): CommandPaletteActionItem[] {
  return variants.map((variant, index) => {
    const blocker = mergeTargets?.[index]?.blocker ?? null;
    const status = targetDescription(variant, scope, signals);
    return {
      kind: "action",
      value: `${prefix}:${variant.key}`,
      searchTerms: [variant.label ?? name, variant.choice.pullRequest?.repository ?? ""],
      title: variant.label ?? name,
      description:
        blocker ??
        (mergeTargets?.[index]?.kind === "auto-merge" ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Turns on auto-merge</span>
            {status}
          </span>
        ) : (
          status
        )),
      icon: variant.choice.pullRequest ? (
        <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />
      ) : (
        <FolderGit2Icon className={ITEM_ICON_CLASS} />
      ),
      ...(blocker ? { disabled: true } : {}),
      run: () => run(variant),
    };
  });
}

/**
 * Fresh details, and activity when `withActivity`, for a JSON
 * `[environmentId, references, withActivity]` key, in reference order.
 */
const pullRequestQueries = Atom.family((key: string) => {
  const [environmentId, references, withActivity] = JSON.parse(key) as [
    EnvironmentId,
    PullRequestRef[],
    boolean,
  ];
  return Atom.make((get) =>
    references.map((reference) => ({
      detail: get(
        pullRequestEnvironment.detail({
          environmentId,
          input: { ...reference, allowStale: false },
        }),
      ),
      activity: withActivity
        ? get(pullRequestEnvironment.activity({ environmentId, input: reference }))
        : null,
    })),
  );
});

interface PullRequestFreshData {
  readonly details: ReadonlyMap<string, PullRequestDetail>;
  readonly activities: ReadonlyMap<string, PullRequestActivity>;
}

/**
 * Fresh details for the thread's open PRs (its merge targets), and their activity when an action
 * reads review threads, keyed by `pullRequestTargetKey`. They are the queries the rows' status
 * lines already load; a PR is missing until its result arrives.
 */
function usePullRequestFreshData(
  scope: QuickActionScope | null,
  variants: readonly QuickActionVariant[],
  withActivity: boolean,
): PullRequestFreshData {
  const projectId = scope?.projectId ?? null;
  const pullRequests = variants.flatMap((variant) =>
    variant.choice.pullRequest && projectId !== null ? [variant.choice.pullRequest] : [],
  );
  const results = useAtomValue(
    pullRequestQueries(
      JSON.stringify([
        scope?.environmentId ?? null,
        pullRequests.map((pullRequest) => ({ ...pullRequest, projectId })),
        withActivity,
      ]),
    ),
  );
  const details = new Map<string, PullRequestDetail>();
  const activities = new Map<string, PullRequestActivity>();
  pullRequests.forEach((pullRequest, index) => {
    const result = results[index];
    const key = pullRequestTargetKey(pullRequest);
    const detail = result ? Option.getOrNull(AsyncResult.value(result.detail)) : null;
    if (detail) details.set(key, detail);
    const activity = result?.activity ? Option.getOrNull(AsyncResult.value(result.activity)) : null;
    if (activity) activities.set(key, activity);
  });
  return { details, activities };
}

/**
 * How each merge target would start, or why it would be refused, so the palette disables it
 * before it is tried. Uses fresh details, and the synced snapshot until they load. Choosing a
 * target still rechecks.
 */
function mergeTargetStates(
  variants: readonly QuickActionVariant[],
  details: ReadonlyMap<string, PullRequestDetail>,
): MergeTarget[] {
  return variants.map((variant) => {
    const pullRequest = variant.choice.pullRequest;
    const detail = pullRequest ? details.get(pullRequestTargetKey(pullRequest)) : undefined;
    const state = detail
      ? pullRequestDetailMergeState(detail)
      : variant.snapshot
        ? pullRequestSnapshotMergeState(variant.snapshot)
        : null;
    if (!state) return { kind: "merge", blocker: null, fresh: false };
    const kind = quickActionMergeKind(state);
    return { kind, blocker: kind ? null : pullRequestMergeBlocker(state), fresh: !!detail };
  });
}

/** "#7: Waiting for CI · #9: Still a draft", or just the reason for a single PR. */
function mergeBlockedSummary(
  variants: readonly QuickActionVariant[],
  targets: readonly MergeTarget[],
): string {
  if (variants.length === 1) return targets[0]?.blocker ?? "Not ready to merge";
  return variants
    .map((variant, index) => `${variant.label ?? "PR"}: ${targets[index]?.blocker ?? "Not ready"}`)
    .join(" · ");
}

/** "1 ready to merge · 1 can auto-merge" for the root row, once every target is fresh. */
function mergeReadySummary(targets: readonly MergeTarget[]): string {
  if (targets.some((target) => !target.fresh && target.kind !== null))
    return "Choose pull requests to merge";
  const ready = targets.filter((target) => target.kind === "merge").length;
  const auto = targets.filter((target) => target.kind === "auto-merge").length;
  return [
    ...(ready ? [`${ready} ready to merge`] : []),
    ...(auto ? [`${auto} can auto-merge when CI passes`] : []),
  ].join(" · ");
}

/** Available rows first, in their order, so dead ends never push actions out of view. */
const availableFirst = (items: readonly QuickActionPaletteItem[]) => [
  ...items.filter((item) => !item.disabled),
  ...items.filter((item) => item.disabled),
];

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
  const mergePullRequests = useQuickActionMerge();
  const git = useQuickActionGit(scope, input.gitCwd, input.onClose);

  const mergeTargets =
    scope?.projectId && scope.thread ? quickActionTargets({ template: "{{pr.url}}" }, scope) : null;
  const mergeVariants = mergeTargets?.kind === "ready" ? mergeTargets.variants : [];
  // Thread counts cost one activity read per open PR, so only load them when an action uses them.
  const readsReviewThreads = library.actions.some(
    (action) => action.enabled && quickActionSignals(action).includes("reviewThreads"),
  );
  const { details, activities } = usePullRequestFreshData(scope, mergeVariants, readsReviewThreads);
  const mergeStates = mergeTargetStates(mergeVariants, details);
  // Fresh states rule out PRs the snapshot cannot, such as one without any checks or threads.
  const fresh = new Map<string, PullRequestKnownState>(
    [...new Set([...details.keys(), ...activities.keys()])].map((key) => [
      key,
      pullRequestKnownState(details.get(key) ?? null, activities.get(key) ?? null),
    ]),
  );

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
        ? quickActionTargets(action, scope, fresh)
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
    const signals = quickActionSignals(action);
    const [only] = targets.variants;
    if (targets.variants.length === 1 && only && target && scope) {
      return {
        ...base,
        kind: "action",
        description: only.choice.pullRequest ? (
          <span className="flex items-center gap-2">
            <span>{only.label}</span>
            {targetDescription(only, scope, signals)}
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
            signals,
            (variant) => run({ action, choice: variant.choice, scope: scope!, target: target! }),
          ),
        },
      ],
    };
  };

  const items: QuickActionPaletteItem[] = [...git.items];
  if (mergeTargets && scope?.projectId) {
    const projectId = scope.projectId;
    const mergeBase = {
      value: "quick-action:merge",
      title: "Merge pull requests",
      searchTerms: ["merge", "pull requests", "squash", "rebase"],
      icon: <PullRequestGlyph.merged className={ITEM_ICON_CLASS} />,
    };
    if (mergeTargets.kind === "ready") {
      const merge = (variants: readonly QuickActionVariant[]) =>
        mergePullRequests(
          scope.environmentId,
          variants.flatMap((variant) =>
            variant.choice.pullRequest ? [{ ...variant.choice.pullRequest, projectId }] : [],
          ),
        );
      if (mergeStates.every((target) => target.kind === null)) {
        items.push({
          ...mergeBase,
          kind: "action",
          description: mergeBlockedSummary(mergeTargets.variants, mergeStates),
          disabled: true,
          run: async () => {},
        });
      } else
        items.push({
          ...mergeBase,
          kind: "submenu",
          description: mergeReadySummary(mergeStates),
          addonIcon: <PullRequestGlyph.merged className={ADDON_ICON_CLASS} />,
          // Always the toggle view, even for one PR, like the other quick actions: pressing a
          // row only toggles it. Submitting checks the selection and stacks the method choice
          // on this view, so the whole batch merges in one palette pass.
          multiSelect: {
            actionLabel: "Continue",
            keepOpen: true,
            run: (values) =>
              merge(
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
                MERGE_SIGNALS,
                // Rows in a toggle view must never submit on their own; only the
                // multi-select submit above starts a merge.
                async () => {},
                mergeStates,
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
  items.push(...rankQuickActionMenu(library.actions, "", recentQuickActionIds()).map(itemFor));
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
  const ordered = availableFirst(items);
  const groups: CommandPaletteGroup[] = [
    ...(ordered.length > 0
      ? [{ value: QUICK_ACTIONS_GROUP, label: "Quick actions", items: ordered }]
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
    searchItems: ordered,
    groups,
    findItem: (actionId: string) => items.find((item) => item.value === `quick-action:${actionId}`),
  };
}
