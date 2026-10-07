import { describe, expect, it } from "vite-plus/test";
import { FORK_IDENTITY } from "./forkIdentity.ts";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

const { development, production } = FORK_IDENTITY.desktop;

describe("provider auth return destinations", () => {
  it.each([production.scheme, development.scheme])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    `${production.scheme}://attacker/welcome`,
    `${production.scheme}://app:123/welcome`,
    `${production.scheme}://app/auth/callback`,
    `${production.scheme}://user@ app/welcome`,
    `${production.scheme}://app/welcome/../evil`,
    "https://attacker.example/welcome",
    "file:///welcome",
    "javascript:alert(1)",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
