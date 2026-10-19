import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useAtomValue } from "@effect/atom-react";
import type { PullRequestDetail, PullRequestMergeMethod, PullRequestRef } from "@t3tools/contracts";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
  pullRequestSnapshotMergeState,
  quickActionMergeActionInput,
  quickActionMergeKind,
  quickActionMergeMethod,
  quickActionMergeMethods,
  quickActionMergePlanLabel,
  quickActionMergePlanSummary,
  quickActionMergeResultTitle,
  type QuickActionMergeKind,
  type QuickActionMergePlan,
} from "@t3tools/client-runtime/pullRequestActions";
import {
  pullRequestSnapshotStatus,
  quickActionTargets,
  type QuickActionVariant,
} from "@t3tools/client-runtime/quickActionRunner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  PickerCaption,
  PickerRow,
  PickerSurface,
  PickerToggleRow,
} from "../../components/PickerList";
import { useThreadShell } from "../../state/entities";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { ForkScreenHeader } from "./ForkScreenHeader";
import type { QuickActionsTarget } from "./MobileQuickActions";

/** The thread's open PRs and merge permission, which the list reads to order the row. */
export function useQuickActionMergeTargets(target: QuickActionsTarget) {
  const thread = useThreadShell(
    target.threadId ? { environmentId: target.environmentId, threadId: target.threadId } : null,
  );
  const canMerge = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(target.environmentId),
  );
  return {
    targets: quickActionTargets({ template: "{{pr.url}}" }, { ...target, thread }),
    canMerge,
  };
}

export function MobileMergeQuickAction(props: {
  target: QuickActionsTarget;
  isLast: boolean;
  choosing: boolean;
  onChoosingChange: (choosing: boolean) => void;
}) {
  const { target } = props;
  const insets = useSafeAreaInsets();
  const { targets, canMerge } = useQuickActionMergeTargets(target);
  const variants = targets.kind === "ready" ? targets.variants : [];
  // The synced snapshot catches the obvious blockers; Continue rechecks fresh status, including
  // required checks, and arms auto-merge for a PR whose required checks still run.
  const blockerOf = (variant: QuickActionVariant) =>
    variant.snapshot
      ? pullRequestMergeBlocker(pullRequestSnapshotMergeState(variant.snapshot))
      : null;
  const loadDetail = useAtomQueryRunner(pullRequestEnvironment.detail, {
    reportFailure: false,
    refresh: true,
  });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [selected, setSelected] = useState<string[]>(() =>
    variants.length === 1 && blockerOf(variants[0]!) === null ? [variants[0]!.key] : [],
  );
  const [confirmation, setConfirmation] = useState<{
    references: PullRequestRef[];
    methods: readonly PullRequestMergeMethod[];
    defaults: ReadonlyArray<QuickActionMergePlan<PullRequestRef>>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const chosen = variants.filter(
    (variant) => selected.includes(variant.key) && blockerOf(variant) === null,
  );
  const prepare = async () => {
    if (inFlight.current || !canMerge || chosen.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const references = chosen.flatMap((variant) =>
        variant.choice.pullRequest
          ? [{ ...variant.choice.pullRequest, projectId: target.projectId }]
          : [],
      );
      const details: PullRequestDetail[] = [];
      const kinds: QuickActionMergeKind[] = [];
      for (const reference of references) {
        setProgress(`Checking ${reference.repository} #${reference.number}…`);
        const result = await loadDetail({
          environmentId: target.environmentId,
          input: { ...reference, allowStale: false },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const state = pullRequestDetailMergeState(result.value);
        const kind = quickActionMergeKind(state);
        if (kind === null)
          throw new Error(
            `${reference.repository} #${reference.number}: ${pullRequestMergeBlocker(state) ?? "Not ready to merge"}.`,
          );
        details.push(result.value);
        kinds.push(kind);
      }
      const defaults = references.map((reference, index) => {
        const method = quickActionMergeMethod(details[index]!);
        if (method === null)
          throw new Error(
            `${reference.repository} #${reference.number}: You can't merge this pull request.`,
          );
        return { reference, kind: kinds[index]!, method };
      });
      // No shared method no longer forces a second pass: the confirmation then offers each
      // repository's default method for the whole batch.
      setConfirmation({ references, methods: quickActionMergeMethods(details), defaults });
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not check pull requests.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const merge = async (plans: ReadonlyArray<QuickActionMergePlan<PullRequestRef>>) => {
    if (inFlight.current || !canMerge || !confirmation) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const succeeded: QuickActionMergePlan<PullRequestRef>[] = [];
    const failures: string[] = [];
    for (const plan of plans) {
      const { reference } = plan;
      if (mounted.current) setProgress(`Merging ${reference.repository} #${reference.number}…`);
      try {
        const result = await runAction({
          environmentId: target.environmentId,
          input: quickActionMergeActionInput(plan),
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        succeeded.push(plan);
      } catch (cause) {
        failures.push(
          `${reference.repository} #${reference.number}: ${cause instanceof Error ? cause.message : "Merge failed."}`,
        );
      }
    }
    inFlight.current = false;
    if (mounted.current) {
      setBusy(false);
      setConfirmation(null);
      setSelected([]);
      props.onChoosingChange(false);
    }
    Alert.alert(
      quickActionMergeResultTitle(plans, succeeded),
      [
        ...succeeded.map(
          (plan) =>
            `${plan.reference.repository} #${plan.reference.number} · ${quickActionMergePlanLabel(plan)}`,
        ),
        ...failures,
      ].join("\n") || "The selected pull requests were merged.",
    );
  };

  if (!props.choosing)
    return (
      <PickerRow
        title="Merge pull requests"
        subtitle={
          !canMerge
            ? "This connection cannot merge pull requests."
            : targets.kind === "unavailable"
              ? targets.reason
              : "Choose pull requests to merge"
        }
        symbol={PullRequestGlyph.merged}
        dimmed={!canMerge || targets.kind === "unavailable"}
        disabled={!canMerge || targets.kind === "unavailable"}
        isLast={props.isLast}
        onPress={() => props.onChoosingChange(true)}
      />
    );

  return (
    <View className="flex-1 bg-sheet">
      <ForkScreenHeader
        title={confirmation ? "Confirm merge" : "Merge pull requests"}
        cancel={{
          label: "Back",
          onPress: () => {
            if (inFlight.current) return;
            if (confirmation) setConfirmation(null);
            else props.onChoosingChange(false);
            setError(null);
          },
        }}
        action={
          confirmation
            ? undefined
            : {
                accessibilityLabel: "Check selected pull requests",
                label: "Continue",
                icon: "checkmark",
                disabled: busy || !canMerge || chosen.length === 0,
                onPress: () => void prepare(),
              }
        }
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          gap: 12,
        }}
      >
        {confirmation ? (
          <>
            <PickerCaption>
              {confirmation.references.map((ref) => `${ref.repository} #${ref.number}`).join(", ")}
            </PickerCaption>
            <PickerSurface>
              {confirmation.methods.length > 0 ? (
                confirmation.methods.map((method, index) => (
                  <PickerRow
                    key={method}
                    title={PULL_REQUEST_MERGE_METHOD_LABELS[method]}
                    subtitle={quickActionMergePlanSummary(confirmation.defaults)}
                    symbol={PullRequestGlyph.merged}
                    isLast={index === confirmation.methods.length - 1}
                    disabled={busy || !canMerge}
                    onPress={() =>
                      void merge(confirmation.defaults.map((plan) => ({ ...plan, method })))
                    }
                  />
                ))
              ) : (
                <PickerRow
                  title="Merge each with its default method"
                  subtitle={confirmation.defaults
                    .map(
                      (plan) =>
                        `${plan.reference.repository} #${plan.reference.number} · ${quickActionMergePlanLabel(plan)}`,
                    )
                    .join(", ")}
                  symbol={PullRequestGlyph.merged}
                  isLast
                  disabled={busy || !canMerge}
                  onPress={() => void merge(confirmation.defaults)}
                />
              )}
            </PickerSurface>
          </>
        ) : (
          <PickerSurface>
            {variants.map((variant, index) => (
              <PickerToggleRow
                key={variant.key}
                title={variant.label ?? "Pull request"}
                subtitle={blockerOf(variant) ?? pullRequestSnapshotStatus(variant.snapshot)}
                value={selected.includes(variant.key) && blockerOf(variant) === null}
                disabled={busy || !canMerge || blockerOf(variant) !== null}
                isLast={index === variants.length - 1}
                onValueChange={(value) =>
                  setSelected((current) =>
                    value
                      ? [...current.filter((key) => key !== variant.key), variant.key]
                      : current.filter((key) => key !== variant.key),
                  )
                }
              />
            ))}
          </PickerSurface>
        )}
        {!canMerge ? (
          <PickerCaption>This connection cannot merge pull requests.</PickerCaption>
        ) : null}
        {targets.kind === "unavailable" && !confirmation ? (
          <PickerCaption>{targets.reason}</PickerCaption>
        ) : null}
        {busy ? (
          <View className="flex-row items-center gap-2" accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" />
            <PickerCaption>{progress}</PickerCaption>
          </View>
        ) : null}
        {error ? <PickerCaption tone="danger">{error}</PickerCaption> : null}
      </ScrollView>
    </View>
  );
}
