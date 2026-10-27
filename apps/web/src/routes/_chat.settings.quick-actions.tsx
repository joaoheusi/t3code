import { createFileRoute } from "@tanstack/react-router";

import { QuickActionsSettingsPanel } from "../components/settings/QuickActionsSettings";

export const Route = createFileRoute("/_chat/settings/quick-actions")({
  component: QuickActionsSettingsPanel,
});
