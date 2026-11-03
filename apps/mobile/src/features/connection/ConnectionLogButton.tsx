import { ConnectionJournal } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";

import { Button } from "../../components/ui/Button";
import { connectionJournal } from "../../connection/journal";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function ConnectionLogButton(props: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
}) {
  return (
    <Button
      label="Copy connection log"
      icon="doc.on.doc"
      tone="secondary"
      onPress={() => {
        const entries = connectionJournal.entries(props.environmentId);
        const text = [
          `Connection log for ${props.hostLabel}`,
          `App ${Constants.expoConfig?.version ?? "unknown"}, copied ${new Date().toISOString()}`,
          entries.length === 0
            ? "No entries since the app started."
            : ConnectionJournal.formatConnectionJournal(entries),
        ].join("\n");
        copyTextWithHaptic(text, { target: "connection-log" });
      }}
    />
  );
}
