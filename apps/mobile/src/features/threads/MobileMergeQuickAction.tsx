import { useAtomValue } from "@effect/atom-react";
import type { PullRequestDetail, PullRequestMergeMethod, PullRequestRef } from "@t3tools/contracts";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  quickActionMergeMethods,
} from "@t3tools/client-runtime/pullRequestActions";
import {
  pullRequestSnapshotStatus,
  quickActionTargets,
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
  const canMerge = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(target.environmentId),
  );
  const loadDetail = useAtomQueryRunner(pullRequestEnvironment.detail, {
    reportFailure: false,
    refresh: true,
  });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [selected, setSelected] = useState<string[]>(() =>
    variants.length === 1 ? variants.map((variant) => variant.key) : [],
  );
  const [confirmation, setConfirmation] = useState<{
    references: PullRequestRef[];
    methods: readonly PullRequestMergeMethod[];
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

  const chosen = variants.filter((variant) => selected.includes(variant.key));
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
      for (const reference of references) {
        setProgress(`Checking ${reference.repository} #${reference.number}…`);
        const result = await loadDetail({
          environmentId: target.environmentId,
          input: { ...reference, allowStale: false },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (quickActionMergeMethods([result.value]).length === 0)
          throw new Error(
            `${reference.repository} #${reference.number} is not ready to merge. Check its CI, conflicts, draft status, and permissions.`,
          );
        details.push(result.value);
      }
      const methods = quickActionMergeMethods(details);
      if (methods.length === 0)
        throw new Error(
          "These pull requests have no merge method in common. Select them separately.",
        );
      setConfirmation({ references, methods });
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Could not check pull requests.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const merge = async (method: PullRequestMergeMethod) => {
    if (inFlight.current || !canMerge || !confirmation) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    let merged = 0;
    for (const reference of confirmation.references) {
      if (mounted.current) setProgress(`Merging ${reference.repository} #${reference.number}…`);
      try {
        const result = await runAction({
          environmentId: target.environmentId,
          input: {
            ...reference,
            action: "merge",
            resolveMergeMethod: (detail) => {
              if (!quickActionMergeMethods([detail]).includes(method))
                throw new Error(
                  "This pull request's status or merge methods changed. Review it again.",
                );
              return method;
            },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        merged++;
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
      `Merged ${merged} of ${confirmation.references.length} pull requests`,
      failures.length ? failures.join("\n") : "The selected pull requests were merged.",
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
              {confirmation.methods.map((method, index) => (
                <PickerRow
                  key={method}
                  title={PULL_REQUEST_MERGE_METHOD_LABELS[method]}
                  subtitle={`Merge ${confirmation.references.length} pull request${confirmation.references.length === 1 ? "" : "s"} now`}
                  symbol="arrow.triangle.merge"
                  isLast={index === confirmation.methods.length - 1}
                  disabled={busy || !canMerge}
                  onPress={() => void merge(method)}
                />
              ))}
            </PickerSurface>
          </>
        ) : (
          <PickerSurface>
            {variants.map((variant, index) => (
              <PickerToggleRow
                key={variant.key}
                title={variant.label ?? "Pull request"}
                subtitle={pullRequestSnapshotStatus(variant.snapshot)}
                value={selected.includes(variant.key)}
                disabled={busy || !canMerge}
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
