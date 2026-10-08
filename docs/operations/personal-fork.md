# Build and verify the personal fork

Baseline: `pingdotgg/t3code` at `f4f148eb670622a049ae6561d7795011e383fc43` (upstream v0.0.45). Fork: `joaoheusi/t3code`, branch `main`, version `0.0.45-j4.7`. Wire protocol: 1002. Fork migrations: 059 (quick actions), 060 (Git operation receipts), 061 (starter action text), 062 (drops unused workspace operation receipts). Multi-repository capability: 2 (folder projects).

The initial target is macOS arm64 desktop plus its bundled responsive web client. Packaging is unsigned and updates are manual. Windows, Linux, native mobile, remote bootstrap archives, signing, notarization, and owned cloud services need their own release verification.

Use the repository's Node and package-manager requirements. Install with `pnpm install --frozen-lockfile`. Run focused checks with:

```sh
bash scripts/verify-fork.sh
```

Build the desktop archive with:

```sh
PATH="$PWD/node_modules/.bin:$PATH" node scripts/build-desktop-artifact.ts \
  --platform mac --arch arm64 --target dmg --output-dir /absolute/output-folder
```

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

Open `J4-Code-0.0.45-j4.7-arm64.dmg`, or unzip `J4-Code-0.0.45-j4.7-arm64.zip`. Copy `J4 Code (Unofficial).app` to a separate folder or to Applications beside the official app. Do not overwrite T3 Code. This archive is unsigned and not notarized. macOS may require an explicit approval in Privacy & Security before it opens. No production profile migration happens automatically.

Start with a fresh fork profile. Check that the title identifies J4 Code and that the chosen execution environment points at the intended host. Configure provider and Git accounts on that host. Complete the open device and provider gates before using it for daily work.

## Roll back

Close J4 Code. Open the unchanged official app to return to official work. Keep the fork profile and working directories until you have inspected any changes. To roll back a fork migration, stop the fork and restore a whole compatible fork-profile backup. Never copy a newer fork database into the official profile or an older binary. This build retains managed worktrees; remove them only after checking ownership, dirty files, unpushed commits, and active terminals.
