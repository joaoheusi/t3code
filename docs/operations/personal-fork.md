# Build and verify the personal fork

Baseline: `pingdotgg/t3code` at `f4f148eb670622a049ae6561d7795011e383fc43` (upstream v0.0.45). Fork: `joaoheusi/t3code`, branch `main`, version `0.1.0-j4.15`. Wire protocol: 1002. Fork migrations: 059 (quick actions), 060 (Git operation receipts), 061 (starter action text), 062 (drops unused workspace operation receipts). Multi-repository capability: 2 (folder projects).

Continuous delivery targets macOS arm64 and the native iPhone app. The desktop release includes its server and web client. Windows, Linux, remote bootstrap archives, and owned cloud services are not published by the fork workflow.

## Continuous delivery

[J4 Code delivery](../../.github/workflows/fork-delivery.yml) runs after CI succeeds on a push to `main`. Manual runs must select `main` and also require passing CI on that commit. Mac releases use `0.2.<main first-parent commit count>`. An older run cannot publish over a newer release. Rerunning a partially completed delivery skips an already published desktop release and retries mobile.

Configure these repository secrets in `joaoheusi/t3code`. They use Cue's names so the same Apple exports can be reused:

- `DEVELOPER_ID_P12_BASE64` and `DEVELOPER_ID_P12_PASSWORD`: the Developer ID Application certificate and export password. Use the existing identity `EC925C91F270121DD2F51F02AF34A320505539DD` from team `SC7RQ3BWQ6` to retain macOS permissions.
- `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER_ID`: an App Store Connect API key for notarization.
- `EXPO_TOKEN`: an Expo access token with access to `@joaoheusi/j4code`.

The Expo project is `33717343-6d0f-44ca-9221-5b8d98737ac5`. Its App Store Connect app is `6829346774`, with bundle ID `com.joaoheusi.j4code`. Configure production iOS signing and submission credentials with EAS. Add yourself to the internal `J4 Personal` TestFlight group, which has access to all builds, and enable Automatic Updates on the iPhone.

The Mac job signs, notarizes, verifies, and uploads all assets to a draft before publishing it. It does not publish the upstream npm package or deploy upstream cloud services. Desktop updates only accept `joaoheusi/t3code`. CLI and standalone server updates remain manual; the bundled server updates with the desktop app.

The iOS job runs after the Mac release. It publishes JavaScript and assets through Expo only when a matching native runtime has been uploaded to TestFlight within 75 days. Otherwise it builds and submits a new native binary. The monthly run refreshes the binary before TestFlight's 90-day expiry. EAS cloud builds run only for a new or expiring runtime, or an explicit **rebuild_ios** request. These builds use the Expo account's build allowance.

Old manually installed builds have updates disabled. Replace the Mac app once and install the TestFlight build over the existing iPhone app without deleting it. Keep the existing identifiers and Apple team so the operating systems can retain app data. Verify saved connections on the actual phone before relying on delivery. When a release changes the wire protocol, update the Mac host before connecting a newer phone client.

For release verification, use isolated profiles and check an actual signed upgrade: available → downloaded → restart → reconnect to the new bundled server. Confirm that background downloading leaves an active agent running. For iOS, verify both an OTA on a matching runtime and a new TestFlight binary, including saved connections and pending drafts. A passing build does not prove those installation paths.

Use the repository's Node and package-manager requirements. Install with `pnpm install --frozen-lockfile`. Run focused checks with:

```sh
bash scripts/verify-fork.sh
```

Build the desktop archive with:

```sh
PATH="$PWD/node_modules/.bin:$PATH" node scripts/build-desktop-artifact.ts \
  --platform mac --arch arm64 --target dmg --output-dir /absolute/output-folder
```

An ad-hoc signed build loses its keychain "Always Allow" and its Screen Recording and Accessibility grants after every rebuild, because macOS ties them to that exact binary. Settings can still show the old grant as on. To keep the approval across builds, set `T3CODE_DESKTOP_MAC_LOCAL_IDENTITY` to the SHA-1 hash of a code-signing certificate from `security find-identity -v -p codesigning`. A certificate name works only when it matches exactly one certificate. This signs the app without notarization. Choose "Always Allow" on the first launch after you switch. Remove the stale J4 Code entries from Screen Recording and Accessibility with the minus button, then grant them again.

Then run the isolated integration fixture:

```sh
node apps/server/scripts/fork-smoke.ts
```

It starts its own server with a private temporary profile and two temporary Git repositories. It verifies authenticated HTTP/RPC, two clients, revision conflicts, durable worktree preparation, scoped files/search/terminals, Git receipts, and restart persistence. It stops its own process and removes only its own fixture directories. It does not open a browser or use an existing pairing link.

The optional `--live-claude` flag starts two live provider turns on those fixture repositories, including a restart between turns. It uses the host's Claude credentials and full-access mode, with a prompt restricted to two fixture files. It is separate from the default offline verification. Check the verification record for the actual result and permission-mode limits.

For manual web verification, start `vp run dev --home-dir /absolute/isolated-home`. For a real tailnet test, use `vp run dev --share --home-dir /absolute/isolated-home`. Give the generated pairing URL to a second device. The runner owns the Serve mapping. Do not configure Serve manually or consume the user's pairing link. Keep tokens and pairing URLs out of reports.

Before replacing a fork build, stop it and back up the whole isolated profile, including SQLite sidecars. Back up Git working files separately. Never run a migrated database through an older or official server. A newer or divergent migration ledger is rejected. Restore a compatible backup or start a fresh isolated profile.

The [verification record](../fork/acceptance-status.json) distinguishes focused automated evidence from unexecuted release cases. An archive building successfully is not evidence of provider authentication, signed callbacks, second-device transport, native mobile compatibility, or all inherited behavior. Record the source commit, OS, architecture, toolchain, protocol, migration number, and SHA-256 alongside each delivered artifact.

## Install the test archive

Open `J4-Code-0.1.0-j4.15-arm64.dmg`, or unzip `J4-Code-0.1.0-j4.15-arm64.zip`. Copy `J4 Code (Unofficial).app` to a separate folder or to Applications beside the official app. Do not overwrite T3 Code. This archive is not notarized. It is ad-hoc signed unless it was built with `T3CODE_DESKTOP_MAC_LOCAL_IDENTITY`, in which case it is signed with that certificate. macOS may require an explicit approval in Privacy & Security before it opens. No production profile migration happens automatically.

Start with a fresh fork profile. Check that the title identifies J4 Code and that the chosen execution environment points at the intended host. Configure provider and Git accounts on that host. Complete the open device and provider gates before using it for daily work.

## Roll back

Close J4 Code. Open the unchanged official app to return to official work. Keep the fork profile and working directories until you have inspected any changes. To roll back a fork migration, stop the fork and restore a whole compatible fork-profile backup. Never copy a newer fork database into the official profile or an older binary. This build retains managed worktrees; remove them only after checking ownership, dirty files, unpushed commits, and active terminals.
