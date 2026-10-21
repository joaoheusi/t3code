import { FORK_IDENTITY } from "@t3tools/shared/forkIdentity";
import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_DOWNLOAD_URL } from "./branding";
import { resolveServerBackedAppDisplayName } from "./branding.logic";

describe("fork branding", () => {
  it("uses the fork release page for desktop downloads", () => {
    expect(DESKTOP_DOWNLOAD_URL).toBe(`https://github.com/${FORK_IDENTITY.repository}/releases`);
  });

  it("uses Nightly for the personal fork server", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "J4 Code (Unofficial)",
        fallbackDisplayName: "J4 Code (Unofficial) (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.45-j4.3",
      }),
    ).toBe("J4 Code (Unofficial) (Nightly)");
  });
});
