import { ServerProviderModel } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import { createMuseSdkHost, makeMuseEnvironment } from "./sdk.ts";
import { museUsageWindows } from "./usageLimits.ts";
import { LATEST_DATE_MS } from "./protocol.ts";
import { parseMuseVersion } from "./maintenance.ts";
import { discoverMuseModels, museModelCapabilities } from "./modelCatalog.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseCliVersionResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  spawnAndCollect,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  showInteractionModeToggle: false,
  reportsContextWindow: true,
  // Muse has no accept-edits mode; map only :ask-me and :unrestricted.
  supportedRuntimeModes: ["approval-required", "full-access"],
} as const;

const FALLBACK_CAPABILITIES = museModelCapabilities();

export const makePendingMuseProvider = Effect.fn("makePendingMuseProvider")(function* (
  settings: MuseSettings,
) {
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings([], settings.customModels, FALLBACK_CAPABILITIES),
    slashCommands: settings.enabled ? [COMPACT_SLASH_COMMAND] : [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Muse Code CLI availability..."
        : "Muse Code is disabled in T3 Code settings.",
    },
  });
});

const MuseUsageReport = Schema.Struct({
  allowance: Schema.NullOr(
    Schema.Struct({
      window: Schema.Struct({ usedPercent: Schema.Finite, resetsAtMs: Schema.Finite }),
      weekly: Schema.Struct({ usedPercent: Schema.Finite, resetsAtMs: Schema.Finite }),
      asOfMs: Schema.optional(Schema.Finite),
    }),
  ),
  hint: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeMuseUsageReport = Schema.decodeUnknownOption(Schema.fromJsonString(MuseUsageReport));

/** Reads subscription limits from `muse usage --json`; never starts a model turn. */
export const checkMuseUsageLimits = Effect.fn("checkMuseUsageLimits")(function* (
  settings: MuseSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = (message?: string) =>
    makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      ...(message ? { message } : {}),
    });
  if (!settings.enabled) return unavailable();
  const museEnvironment = environment ?? makeMuseEnvironment();
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["usage", "--json"], {
      env: museEnvironment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: museEnvironment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(result) || Option.isNone(result.success)) return unavailable();
  const output = result.success.value;
  if (output.code !== 0) return unavailable();
  const report = decodeMuseUsageReport(output.stdout);
  if (Option.isNone(report)) return unavailable();
  const { allowance, hint, reason } = report.value;
  if (allowance === null) return unavailable(hint ?? reason ?? undefined);
  const asOfMs = allowance.asOfMs;
  const observedAt =
    asOfMs !== undefined && Number.isFinite(asOfMs) && asOfMs > 0 && asOfMs <= LATEST_DATE_MS
      ? DateTime.formatIso(DateTime.makeUnsafe(asOfMs))
      : checkedAt;
  return makeUsageLimits({ checkedAt: observedAt, windows: museUsageWindows(allowance) });
});

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  settings: MuseSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  if (!settings.enabled) return yield* makePendingMuseProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const museEnvironment = providerProbeEnvironment(environment ?? makeMuseEnvironment());
  const snapshot = (probe: ProviderProbeResult, models: ReadonlyArray<ServerProviderModel> = []) =>
    buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(models, settings.customModels, FALLBACK_CAPABILITIES),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe,
    });
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      env: museEnvironment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: museEnvironment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Muse Code CLI (`muse`) was not found. Install Muse Code and run `muse login` on this T3 server host."
        : "Failed to execute Muse Code CLI. Check its binary path on this T3 server host.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Muse Code CLI version check timed out.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput, parseMuseVersion);
  if (versionOutput.code !== 0) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Muse Code CLI is installed but failed to run.",
    });
  }

  const catalog = yield* discoverMuseModels(settings, museEnvironment, cwd, createHost).pipe(
    Effect.scoped,
    Effect.timeoutOption(12_000),
    Effect.result,
  );
  if (Result.isFailure(catalog) || Option.isNone(catalog.success)) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Muse Code SDK could not read the model catalog. Check your Muse installation and run `muse login` on this T3 server host.",
    });
  }
  const models = catalog.success.value;
  // MSP has no auth signal and serves cached models while logged out; failures surface on first turn.
  return snapshot(
    {
      installed: true,
      version,
      auth: { status: "unknown" },
      ...(models.length > 0
        ? { status: "ready" }
        : {
            status: "warning",
            message:
              "Muse Code returned no models. Run `muse login` on this T3 server host and refresh its status.",
          }),
    },
    models,
  );
});
