import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FORK_IDENTITY } from "@t3tools/shared/forkIdentity";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const resolveWindowsUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    isDevelopment: false,
    platform: "win32",
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("never migrates the official Windows profile state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
      for (const official of ["T3 Code (Alpha)", "t3code", "t3code-v2"]) {
        yield* fileSystem.makeDirectory(path.join(root, official));
        yield* fileSystem.writeFileString(path.join(root, official, "Local State"), "keys");
      }

      const userData = yield* resolveWindowsUserData(root);

      assert.equal(
        userData,
        path.join(root, FORK_IDENTITY.desktop.production.userDataDirectoryName),
      );
      assert.isFalse(yield* fileSystem.exists(userData));
    }),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable path as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(
          DesktopPreReadyFileSystem.make.exists(path.join(root, "Local State")),
        );

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
