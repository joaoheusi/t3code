#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
./node_modules/.bin/vp test run \
  apps/desktop/src/app/DesktopUserData.test.ts \
  apps/desktop/src/app/DesktopAppIdentity.test.ts \
  apps/desktop/src/app/DesktopEnvironment.test.ts \
  apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts \
  packages/shared/src/cliRelease.test.ts \
  packages/shared/src/devHome.test.ts \
  packages/shared/src/quickActions.test.ts \
  packages/shared/src/actionContext.test.ts \
  packages/shared/src/workspaceTerminal.test.ts \
  packages/ssh/src/tunnel.test.ts \
  packages/tailscale/src/tailscale.test.ts \
  packages/client-runtime/src/actions/dispatcher.test.ts \
  apps/server/src/quickActions/QuickActions.test.ts \
  apps/server/src/workspace/WorkspaceRepositories.test.ts \
  apps/server/src/workspace/WorkspacePreparation.test.ts \
  apps/server/src/workspace/WorkspaceOperations.test.ts \
  apps/server/src/checkpointing/CheckpointDiffQuery.test.ts \
  apps/server/src/persistence/reconcileV2PreviewMigration.test.ts \
  apps/server/src/storageCleanup.test.ts \
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  apps/server/src/cli/app.test.ts \
  apps/server/src/cli/config.test.ts \
  apps/server/src/cli/invocation.test.ts \
  apps/server/src/auth/RpcAuthorization.test.ts \
  apps/server/src/auth/http.test.ts \
  apps/web/src/quickActions/atomicUndo.test.ts \
  apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts \
  scripts/dev-runner.test.ts \
  scripts/build-desktop-artifact.test.ts
for project in apps/server apps/web packages/client-runtime apps/desktop scripts; do
  ./node_modules/.bin/tsc --noEmit -p "$project/tsconfig.json"
done
