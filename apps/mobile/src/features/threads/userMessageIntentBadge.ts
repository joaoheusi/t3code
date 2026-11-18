import type { OrchestrationV2UserMessageInputIntent } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export interface UserMessageIntentBadgePresentation {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly explanation: string;
  readonly tone: "queued" | "steer";
}

export function resolveUserMessageIntentBadge(
  intent: OrchestrationV2UserMessageInputIntent | undefined,
  unread = false,
  resolve: MessageResolver = m,
): UserMessageIntentBadgePresentation | null {
  if (unread && (intent === "steer" || intent === "promoted_queued_to_steer")) {
    return {
      label: resolve(msg("Steer · waiting to be read")),
      accessibilityLabel: resolve(
        msg("Steer waiting for the agent to read it after the running command finishes"),
      ),
      explanation: resolve(
        msg(
          "This message was intended to steer the agent while its turn was still running. The agent has not read it yet.",
        ),
      ),
      tone: "steer",
    };
  }
  switch (intent) {
    case "queued_turn":
      return {
        label: resolve(msg("from queue")),
        accessibilityLabel: resolve(msg("Queued while the agent was busy")),
        explanation: resolve(
          msg(
            "This badge records that the message was queued. It stays visible after the message leaves the queue.",
          ),
        ),
        tone: "queued",
      };
    case "steer":
      return {
        label: resolve(msg("Steer", { $context: "badge, message sent into the running turn" })),
        accessibilityLabel: resolve(msg("Steered the active turn")),
        explanation: resolve(
          msg("This message was intended to steer the agent while its turn was still running."),
        ),
        tone: "steer",
      };
    case "promoted_queued_to_steer":
      return {
        label: resolve(msg("Steer", { $context: "badge, message sent into the running turn" })),
        accessibilityLabel: resolve(
          msg("Originally queued, then promoted to steer the active turn"),
        ),
        explanation: resolve(
          msg(
            "This message was originally queued, then promoted to steer the agent while its turn was still running.",
          ),
        ),
        tone: "steer",
      };
    case "turn_start":
    case undefined:
      return null;
  }
}
