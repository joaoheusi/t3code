#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
./node_modules/.bin/vp test run \
  apps/desktop/src/app/DesktopUserData.test.ts \
  apps/desktop/src/app/DesktopAppIdentity.test.ts \
  packages/shared/src/cliRelease.test.ts \
  packages/ssh/src/tunnel.test.ts
./node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json
./node_modules/.bin/tsc --noEmit -p scripts/tsconfig.json
