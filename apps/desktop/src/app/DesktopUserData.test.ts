import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "linux", "win32"] as const)(
  "isolates the %s fork profile without reading official credentials",
  (platform) =>
    Effect.gen(function* () {
      const destination = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: false,
        platform,
      });
      assert.equal(destination, "/profiles/j4code");
      const development = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: true,
        platform,
      });
      assert.equal(development, "/profiles/j4code-dev");
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provide(NodeServices.layer),
    ),
);
