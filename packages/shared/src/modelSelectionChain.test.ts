import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createModelSelection } from "./model.ts";
import {
  dedupeModelSelectionChain,
  effectiveDefaultModelSelectionChain,
  isUsageExhaustedForModel,
  resolveDefaultModelSelectionForNewThread,
  resolveDefaultModelSelectionFromChain,
  syncDefaultModelSelectionPair,
} from "./modelSelectionChain.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:00:00.000Z";

const claudeA = ProviderInstanceId.make("claude-a");
const claudeB = ProviderInstanceId.make("claude-b");
const codexA = ProviderInstanceId.make("codex-a");

const opusA = createModelSelection(claudeA, "claude-opus-5-5");
const opusB = createModelSelection(claudeB, "claude-opus-5-5");
const solA = createModelSelection(codexA, "gpt-6.1-sol");
const chain = [opusA, opusB, solA];

function limits(usedPercent: number, overrides?: Partial<ServerProviderUsageLimits>) {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        resetsAt: "2026-09-03T14:00:00.000Z",
      },
    ],
    ...overrides,
  } satisfies ServerProviderUsageLimits;
}

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: claudeA,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("resolveDefaultModelSelectionFromChain", () => {
  it("walks the chain in order past used-up accounts", () => {
    const providers = [
      provider({ instanceId: claudeA, usageLimits: limits(100) }),
      provider({ instanceId: claudeB, usageLimits: limits(100) }),
      provider({
        instanceId: codexA,
        driver: ProviderDriverKind.make("codex"),
        usageLimits: limits(20),
      }),
    ];
    expect(resolveDefaultModelSelectionFromChain({ chain, providers, now })).toEqual(solA);
    expect(
      resolveDefaultModelSelectionFromChain({
        chain,
        providers: [
          provider({ instanceId: claudeA, usageLimits: limits(100) }),
          provider({ instanceId: claudeB, usageLimits: limits(35) }),
        ],
        now,
      }),
    ).toEqual(opusB);
  });

  it("keeps the head when every entry is used up", () => {
    const providers = [
      provider({ instanceId: claudeA, usageLimits: limits(100) }),
      provider({ instanceId: claudeB, usageLimits: limits(100) }),
      provider({ instanceId: codexA, usageLimits: limits(100) }),
    ];
    expect(resolveDefaultModelSelectionFromChain({ chain, providers, now })).toEqual(opusA);
  });

  it("skips an account that just reported a usage-limit failure", () => {
    expect(
      resolveDefaultModelSelectionFromChain({
        chain,
        providers: [],
        now,
        limitedInstanceIds: new Set([claudeA]),
      }),
    ).toEqual(opusB);
  });

  it("skips disabled accounts and keeps unseen accounts eligible", () => {
    expect(
      resolveDefaultModelSelectionFromChain({
        chain,
        providers: [provider({ instanceId: claudeA, enabled: false })],
        now,
      }),
    ).toEqual(opusB);
    expect(resolveDefaultModelSelectionFromChain({ chain, providers: [], now })).toEqual(opusA);
    expect(resolveDefaultModelSelectionFromChain({ chain: [], providers: [], now })).toBeNull();
  });
});

describe("isUsageExhaustedForModel", () => {
  it("needs a full window that has not reset yet", () => {
    expect(isUsageExhaustedForModel({ limits: limits(99), model: "opus", now })).toBe(false);
    expect(isUsageExhaustedForModel({ limits: limits(100), model: "opus", now })).toBe(true);
    expect(
      isUsageExhaustedForModel({
        limits: {
          checkedAt,
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: "2026-09-03T11:00:00.000Z",
            },
          ],
        },
        model: "opus",
        now,
      }),
    ).toBe(false);
  });

  it("ignores a full window that names another model family", () => {
    const opusWeekly = {
      checkedAt,
      windows: [
        {
          id: "seven_day_opus",
          kind: "weekly",
          label: "Opus weekly",
          usedPercent: 100,
          resetsAt: "2026-09-06T12:00:00.000Z",
        },
      ],
    } satisfies ServerProviderUsageLimits;
    expect(isUsageExhaustedForModel({ limits: opusWeekly, model: "claude-sonnet-5", now })).toBe(
      false,
    );
    expect(isUsageExhaustedForModel({ limits: opusWeekly, model: "claude-opus-5-5", now })).toBe(
      true,
    );
  });

  it("stays eligible without data, when unsupported, and for Cursor's combined total", () => {
    expect(isUsageExhaustedForModel({ limits: undefined, model: "opus", now })).toBe(false);
    expect(
      isUsageExhaustedForModel({
        limits: limits(100, { unavailable: { reason: "unsupported" } }),
        model: "opus",
        now,
      }),
    ).toBe(false);
    expect(
      isUsageExhaustedForModel({
        limits: {
          checkedAt,
          windows: [
            { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 },
          ],
        },
        model: "gpt-6.1-sol",
        now,
      }),
    ).toBe(false);
  });
});

describe("chain settings helpers", () => {
  it("treats a legacy single default as a one-entry chain", () => {
    expect(
      effectiveDefaultModelSelectionChain({
        defaultModelSelection: opusA,
        defaultModelSelectionChain: [],
      }),
    ).toEqual([opusA]);
    expect(
      resolveDefaultModelSelectionForNewThread({
        settings: { defaultModelSelection: opusA, defaultModelSelectionChain: chain },
        providers: [provider({ instanceId: claudeA, usageLimits: limits(100) })],
        now,
      }),
    ).toEqual(opusB);
  });

  it("dedupes while preserving order", () => {
    expect(dedupeModelSelectionChain([opusA, opusB, opusA, solA, opusB])).toEqual(chain);
  });

  it("mirrors the chain head into the single default", () => {
    expect(
      syncDefaultModelSelectionPair({
        current: { defaultModelSelection: null, defaultModelSelectionChain: [] },
        chain,
      }),
    ).toEqual({ defaultModelSelection: opusA, defaultModelSelectionChain: chain });
    expect(
      syncDefaultModelSelectionPair({
        current: { defaultModelSelection: opusA, defaultModelSelectionChain: chain },
        chain: [],
      }),
    ).toEqual({ defaultModelSelection: null, defaultModelSelectionChain: [] });
  });

  it("makes a single-default write the new head without dropping fallbacks", () => {
    expect(
      syncDefaultModelSelectionPair({
        current: { defaultModelSelection: opusA, defaultModelSelectionChain: chain },
        single: solA,
      }),
    ).toEqual({ defaultModelSelection: solA, defaultModelSelectionChain: [solA, opusA, opusB] });
    expect(
      syncDefaultModelSelectionPair({
        current: { defaultModelSelection: opusA, defaultModelSelectionChain: chain },
        single: null,
      }),
    ).toEqual({ defaultModelSelection: null, defaultModelSelectionChain: [] });
  });
});
