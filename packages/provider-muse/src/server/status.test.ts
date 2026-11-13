import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus, checkMuseUsageLimits } from "./status.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [] },
    connection: {
      request: vi.fn(async () => catalog),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "muse-wonder-1.0",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("tells the user to finish setup when the launcher has not installed its runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // What Muse's launcher prints when a fresh install runs under MUSE_NO_AUTO_UPDATE=1.
        const binaryPath = yield* fakeCli(
          'process.stderr.write("muse: installed binary is missing; rerun the installer\\n");process.exit(1);',
        );
        const snapshot = yield* checkMuseProviderStatus(settings({ enabled: true, binaryPath }));
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("muse --version");
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-wonder-1.0",
          "muse-custom",
        ]);
        expect(snapshot.models.map((model) => model.name)).toEqual([
          "Muse Wonder 1.0",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("reads subscription limits from muse usage --json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          `process.stdout.write(JSON.stringify({schemaVersion:1,allowance:{tier:"Muse Code Power Usage",window:{usedPercent:9,resetsAtMs:1793910086000},weekly:{usedPercent:43,resetsAtMs:1794182400000},asOfMs:1793893825400,source:"mint"},reason:null,hint:null}));`,
        );
        const limits = yield* checkMuseUsageLimits(settings({ enabled: true, binaryPath }));
        expect(limits.unavailable).toBeUndefined();
        expect(limits.checkedAt).toBe("2026-11-05T15:50:25.400Z");
        expect(limits.windows).toEqual([
          {
            id: "session",
            kind: "session",
            label: "Session",
            usedPercent: 9,
            resetsAt: "2026-11-05T20:21:26.000Z",
          },
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 43,
            resetsAt: "2026-11-09T00:00:00.000Z",
            windowDurationMins: 10080,
          },
        ]);
      }),
    ),
  );

  it.effect("reports limits unavailable without an allowance or a working CLI", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signedOut = yield* fakeCli(
          `process.stdout.write(JSON.stringify({schemaVersion:1,allowance:null,reason:"signed_out",hint:"Run muse login"}));`,
        );
        const noAllowance = yield* checkMuseUsageLimits(
          settings({ enabled: true, binaryPath: signedOut }),
        );
        expect(noAllowance.windows).toEqual([]);
        expect(noAllowance.unavailable).toEqual({
          reason: "probeFailed",
          message: "Run muse login",
        });

        const broken = yield* fakeCli("process.exit(3);");
        const failed = yield* checkMuseUsageLimits(settings({ enabled: true, binaryPath: broken }));
        expect(failed.windows).toEqual([]);
        expect(failed.unavailable?.reason).toBe("probeFailed");

        const garbage = yield* fakeCli('process.stdout.write("not json");');
        const unreadable = yield* checkMuseUsageLimits(
          settings({ enabled: true, binaryPath: garbage }),
        );
        expect(unreadable.unavailable?.reason).toBe("probeFailed");
      }),
    ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );
});
