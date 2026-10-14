import { useAtomValue } from "@effect/atom-react";
import type { PullRequestMergeMethod, PullRequestRef } from "@t3tools/contracts";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  allowedPullRequestMergeMethods,
  pullRequestDetailMergeState,
  pullRequestMergeBlocker,
  quickActionMergeMethod,
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

/**
 * Merges every toggled PR in one pass, like the other quick actions finish in their picker.
 * Fresh status is checked first; each PR then merges with its own default method, so
 * repositories that allow different methods never force a second pass.
 */
export function MobileMergeQuickAction(props: {
  target: QuickActionsTarget;
  isLast: boolean;
  choosing: boolean;
  onChoosingChange: (choosing: boolean) => void;
}) {
  const { target } = props;
  const insets = useSafeAreaInsets();
  const thread = useThreadShell(
    target.threadId ? { environmentId: target.environmentId, threadId: target.threadId } : null,
  );
  const targets = quickActionTargets({ template: "{{pr.url}}" }, { ...target, thread });
  const variants = targets.kind === "ready" ? targets.variants : [];
  // The synced snapshot catches the obvious blockers; Merge rechecks fresh status.
  const blockerOf = (variant: QuickActionVariant) =>
    variant.snapshot ? pullRequestMergeBlocker(variant.snapshot) : null;
  const canMerge = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(target.environmentId),
  );
  const loadDetail = useAtomQueryRunner(pullRequestEnvironment.detail, {
    reportFailure: false,
    refresh: true,
  });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [selected, setSelected] = useState<string[]>(() =>
    variants.length === 1 && blockerOf(variants[0]!) === null ? [variants[0]!.key] : [],
  );
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
  const merge = async () => {
    if (inFlight.current || !canMerge || chosen.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const merged: string[] = [];
    const failures: string[] = [];
    let total = 0;
    try {
      const plans: Array<{
        readonly reference: PullRequestRef;
        readonly method: PullRequestMergeMethod;
      }> = [];
      for (const variant of chosen) {
        if (!variant.choice.pullRequest) continue;
        const reference = { ...variant.choice.pullRequest, projectId: target.projectId };
        setProgress(`Checking ${reference.repository} #${reference.number}…`);
        const result = await loadDetail({
          environmentId: target.environmentId,
          input: { ...reference, allowStale: false },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const blocker = pullRequestMergeBlocker(pullRequestDetailMergeState(result.value));
        if (blocker) throw new Error(`${reference.repository} #${reference.number}: ${blocker}.`);
        const method = quickActionMergeMethod(result.value);
        if (method === null)
          throw new Error(
            `${reference.repository} #${reference.number}: You can't merge this pull request.`,
          );
        plans.push({ reference, method });
      }
      total = plans.length;
      for (const { reference, method } of plans) {
        if (mounted.current) setProgress(`Merging ${reference.repository} #${reference.number}…`);
        try {
          const result = await runAction({
            environmentId: target.environmentId,
            input: {
              ...reference,
              action: "merge",
              resolveMergeMethod: (detail) => {
                if (
                  quickActionMergeMethod(detail) === null ||
                  !allowedPullRequestMergeMethods(detail).includes(method)
                )
                  throw new Error(
                    "This pull request's status or allowed merge methods changed. Review it again.",
                  );
                return method;
              },
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          merged.push(
            `${reference.repository} #${reference.number} · ${PULL_REQUEST_MERGE_METHOD_LABELS[method]}`,
          );
        } catch (cause) {
          failures.push(
            `${reference.repository} #${reference.number}: ${cause instanceof Error ? cause.message : "Merge failed."}`,
          );
        }
      }
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not check pull requests.");
      return;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
    if (mounted.current) {
      setSelected([]);
      props.onChoosingChange(false);
    }
    Alert.alert(
      `Merged ${merged.length} of ${total} pull requests`,
      [...merged, ...failures].join("\n") || "The selected pull requests were merged.",
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
        symbol="arrow.triangle.merge"
        dimmed={!canMerge || targets.kind === "unavailable"}
        disabled={!canMerge || targets.kind === "unavailable"}
        isLast={props.isLast}
        onPress={() => props.onChoosingChange(true)}
      />
    );

  return (
    <View className="flex-1 bg-sheet">
      <ForkScreenHeader
        title="Merge pull requests"
        cancel={{
          label: "Back",
          onPress: () => {
            if (inFlight.current) return;
            props.onChoosingChange(false);
            setError(null);
          },
        }}
        action={{
          accessibilityLabel: "Merge selected pull requests",
          label: "Merge",
          icon: "checkmark",
          disabled: busy || !canMerge || chosen.length === 0,
          onPress: () => void merge(),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          gap: 12,
        }}
      >
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
        {!canMerge ? (
          <PickerCaption>This connection cannot merge pull requests.</PickerCaption>
        ) : null}
        {targets.kind === "unavailable" ? <PickerCaption>{targets.reason}</PickerCaption> : null}
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
