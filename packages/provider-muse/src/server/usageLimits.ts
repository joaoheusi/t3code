import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import type { ProviderUsageLimitsReport } from "@t3tools/provider-core/server/snapshot";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

const isoMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Muse's account-wide report as Limits windows, with its tier as the plan. */
export function museUsageToLimits(usage: MuseSubscriptionUsage): ProviderUsageLimitsReport {
  const tier = usage.tier.trim();
  return {
    checkedAt: isoMillis(usage.observedAtMs),
    windows: [
      {
        id: "session",
        kind: "session",
        label: "Session",
        usedPercent: clampPercent(usage.window.usedPercent),
        resetsAt: isoMillis(usage.window.resetsAtMs),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        resetsAt: isoMillis(usage.weekly.resetsAtMs),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
    ...(tier ? { authLabel: tier } : {}),
  };
}

/** Credential proxies may omit error.quota from 429 refusals; inspect text too. */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

export const MUSE_TOOL_SCHEMA_TOO_DEEP_CODE = "tool_schema_too_deep";

/**
 * Meta rejects tool schemas nested beyond 10 levels. Loaded tools persist in the
 * native session, so this failure repeats on every later turn until it is replaced.
 */
export function isMuseToolSchemaTooDeepFailure(message: string | undefined): boolean {
  return message !== undefined && /JSON schema exceeds the maximum nesting depth/i.test(message);
}

export const MUSE_TOOL_SCHEMA_TOO_DEEP_MESSAGE =
  "A tool available to Muse has a JSON schema nested deeper than the model API allows (10 levels), so this Muse session cannot run more turns. Your next message starts a fresh session with this thread's context. To stop it recurring, disable the MCP server that provides the tool in your Muse configuration.";

const WEEK_MINS = 7 * 24 * 60;

/** Session and weekly windows for Usage limits; Meta percentages may exceed 100. */
export function museUsageWindows(input: {
  readonly window: {
    readonly usedPercent: number;
    readonly resetsAtMs: number;
    readonly windowDurationMins?: number;
  };
  readonly weekly: { readonly usedPercent: number; readonly resetsAtMs: number };
}): ReadonlyArray<ServerProviderUsageWindow> {
  const resetIso = (ms: number) =>
    Number.isFinite(ms) && ms > 0 && ms <= LATEST_DATE_MS
      ? DateTime.formatIso(DateTime.makeUnsafe(ms))
      : undefined;
  const sessionReset = resetIso(input.window.resetsAtMs);
  const weeklyReset = resetIso(input.weekly.resetsAtMs);
  const duration = input.window.windowDurationMins;
  return [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: clampPercent(input.window.usedPercent),
      ...(sessionReset !== undefined ? { resetsAt: sessionReset } : {}),
      ...(duration !== undefined && Number.isFinite(duration) && duration > 0
        ? { windowDurationMins: Math.round(duration) }
        : {}),
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(input.weekly.usedPercent),
      ...(weeklyReset !== undefined ? { resetsAt: weeklyReset } : {}),
      windowDurationMins: WEEK_MINS,
    },
  ];
}

export function museSubscriptionUsageUpdate(usage: MuseSubscriptionUsage): {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly checkedAt: string;
} {
  return {
    windows: museUsageWindows(usage),
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
  };
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/** Resume only after all exhausted windows reset; use the latest future reset from quota, refusal, or usage. */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? isoMillis(Math.max(...resets)) : null;
}
