import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { modelSelectionsEqual } from "./model.ts";

const nowMillis = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

export type DefaultModelSelectionSettings = Pick<
  ServerSettings,
  "defaultModelSelection" | "defaultModelSelectionChain"
>;

/** Keeps the first occurrence of each selection, preserving user order. */
export function dedupeModelSelectionChain(
  chain: readonly ModelSelection[],
): readonly ModelSelection[] {
  const result: ModelSelection[] = [];
  for (const entry of chain) {
    if (!result.some((seen) => modelSelectionsEqual(seen, entry))) result.push(entry);
  }
  return result;
}

/**
 * The chain a new thread should walk. Settings written before the chain
 * existed carry only the single default, which becomes a one-entry chain.
 */
export function effectiveDefaultModelSelectionChain(
  settings: DefaultModelSelectionSettings,
): readonly ModelSelection[] {
  const chain = dedupeModelSelectionChain(settings.defaultModelSelectionChain);
  if (chain.length > 0) return chain;
  return settings.defaultModelSelection === null ? [] : [settings.defaultModelSelection];
}

/**
 * Keeps the pair coherent when either side is written: the single default
 * always mirrors the head of the chain, and a single-default write from an
 * older client becomes the new head without dropping saved fallbacks.
 */
export function syncDefaultModelSelectionPair(input: {
  readonly current: DefaultModelSelectionSettings;
  readonly chain?: readonly ModelSelection[] | undefined;
  readonly single?: ModelSelection | null | undefined;
}): DefaultModelSelectionSettings | null {
  if (input.chain !== undefined) {
    const chain = dedupeModelSelectionChain(input.chain);
    return { defaultModelSelectionChain: chain, defaultModelSelection: chain[0] ?? null };
  }
  if (input.single === undefined) return null;
  if (input.single === null) return { defaultModelSelectionChain: [], defaultModelSelection: null };
  return {
    defaultModelSelection: input.single,
    defaultModelSelectionChain: dedupeModelSelectionChain([
      input.single,
      ...effectiveDefaultModelSelectionChain(input.current),
    ]),
  };
}

const MODEL_FAMILY_TOKENS = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "gpt",
  "gemini",
  "grok",
  "composer",
] as const;

/**
 * A window naming another model family (`seven_day_opus` for a Sonnet pick)
 * says nothing about this model. A window naming no family is account-wide.
 */
function windowAppliesToModel(window: ServerProviderUsageWindow, model: string): boolean {
  const id = window.id.toLowerCase();
  const named = MODEL_FAMILY_TOKENS.filter((token) => id.includes(token));
  if (named.length === 0) return true;
  const slug = model.toLowerCase();
  return named.some((token) => slug.includes(token));
}

/**
 * Whether the reported limits leave no room for `model`. No data, an
 * unsupported account, and a failed probe all stay eligible: only a window
 * actually at 100% before its reset counts as used up. Cursor's combined
 * total is not a quota of its own, so it never exhausts an entry alone.
 */
export function isUsageExhaustedForModel(input: {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly model: string;
  readonly now?: number | undefined;
}): boolean {
  const { limits } = input;
  if (limits === undefined || limits.unavailable !== undefined) return false;
  const now = input.now ?? nowMillis();
  return limits.windows.some((window) => {
    if (window.id === "totalPercentUsed") return false;
    if (window.usedPercent < 100) return false;
    if (!windowAppliesToModel(window, input.model)) return false;
    if (window.resetsAt !== undefined) {
      const resetsAt = Date.parse(window.resetsAt);
      if (Number.isFinite(resetsAt) && resetsAt <= now) return false;
    }
    return true;
  });
}

export interface ResolveDefaultModelSelectionInput {
  readonly chain: readonly ModelSelection[];
  readonly providers: readonly ServerProvider[];
  readonly now?: number | undefined;
  /**
   * Instances that just failed a turn with a usage limit. Their snapshot
   * usually catches up within seconds; this covers the gap for a new thread
   * started in between.
   */
  readonly limitedInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}

/**
 * First chain entry whose account still has room. Entries on accounts the
 * client cannot see stay eligible. When every entry is used up the head of
 * the chain wins, so the thread keeps the user's top preference and the
 * existing usage-limit recovery flow takes over from there.
 */
export function resolveDefaultModelSelectionFromChain(
  input: ResolveDefaultModelSelectionInput,
): ModelSelection | null {
  const chain = dedupeModelSelectionChain(input.chain);
  if (chain.length === 0) return null;
  const byInstance = new Map(input.providers.map((provider) => [provider.instanceId, provider]));
  for (const entry of chain) {
    if (input.limitedInstanceIds?.has(entry.instanceId)) continue;
    const provider = byInstance.get(entry.instanceId);
    if (provider !== undefined) {
      if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) continue;
      if (
        isUsageExhaustedForModel({
          limits: provider.usageLimits,
          model: entry.model,
          ...(input.now === undefined ? {} : { now: input.now }),
        })
      ) {
        continue;
      }
    }
    return entry;
  }
  return chain[0] ?? null;
}

/**
 * Instances whose latest turn failed with a usage limit that resets in the
 * future. Callers pass their thread shells; entries without a known reset
 * rely on the limits snapshot instead, so a stale failure cannot block an
 * account forever.
 */
export function limitedInstanceIdsFromFailures(
  failures: Iterable<{
    readonly instanceId: ProviderInstanceId;
    readonly usageLimitResetAt?: string | null | undefined;
  }>,
  now: number = nowMillis(),
): ReadonlySet<ProviderInstanceId> {
  const limited = new Set<ProviderInstanceId>();
  for (const failure of failures) {
    if (failure.usageLimitResetAt == null) continue;
    const resetsAt = Date.parse(failure.usageLimitResetAt);
    if (Number.isFinite(resetsAt) && resetsAt > now) limited.add(failure.instanceId);
  }
  return limited;
}

export function resolveDefaultModelSelectionForNewThread(input: {
  readonly settings: DefaultModelSelectionSettings;
  readonly providers: readonly ServerProvider[];
  readonly now?: number | undefined;
  readonly limitedInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}): ModelSelection | null {
  return resolveDefaultModelSelectionFromChain({
    chain: effectiveDefaultModelSelectionChain(input.settings),
    providers: input.providers,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.limitedInstanceIds === undefined
      ? {}
      : { limitedInstanceIds: input.limitedInstanceIds }),
  });
}
