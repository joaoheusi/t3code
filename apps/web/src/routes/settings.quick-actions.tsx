import { createFileRoute } from "@tanstack/react-router";
import { QuickActionLibrary } from "../quickActions/QuickActionLibrary";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
export const Route = createFileRoute("/settings/quick-actions")({
  component: QuickActionsSettings,
});
function QuickActionsSettings() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <h1>Quick actions</h1>
      {environment ? (
        <QuickActionLibrary
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p>Select one connected environment to manage its action library.</p>
      )}
    </SettingsPageContainer>
  );
}
