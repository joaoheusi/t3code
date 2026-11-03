import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";

export type ConnectionJournalField = string | number | boolean;

export interface ConnectionJournalEntry {
  readonly at: number;
  readonly event: string;
  readonly fields: Readonly<Record<string, ConnectionJournalField>>;
}

export interface ConnectionJournalService {
  readonly record: (environmentId: EnvironmentId, entry: ConnectionJournalEntry) => void;
}

/** Records why each environment connection changed, so a user can report an outage after it ends. */
export class ConnectionJournal extends Context.Reference(
  "@t3tools/client-runtime/connection/journal/ConnectionJournal",
  { defaultValue: (): ConnectionJournalService => ({ record: () => undefined }) },
) {}

export interface MemoryConnectionJournal extends ConnectionJournalService {
  readonly entries: (environmentId: EnvironmentId) => ReadonlyArray<ConnectionJournalEntry>;
}

const MAX_FIELD_LENGTH = 500;

function capField(value: ConnectionJournalField): ConnectionJournalField {
  return typeof value === "string" && value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}…`
    : value;
}

export function makeMemory(capacity = 300): MemoryConnectionJournal {
  const byEnvironment = new Map<EnvironmentId, Array<ConnectionJournalEntry>>();
  return {
    record: (environmentId, entry) => {
      let entries = byEnvironment.get(environmentId);
      if (entries === undefined) {
        entries = [];
        byEnvironment.set(environmentId, entries);
      }
      entries.push({
        ...entry,
        fields: Object.fromEntries(
          Object.entries(entry.fields).map(([key, value]) => [key, capField(value)]),
        ),
      });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    entries: (environmentId) => byEnvironment.get(environmentId) ?? [],
  };
}

export function formatConnectionJournal(entries: ReadonlyArray<ConnectionJournalEntry>): string {
  return entries
    .map((entry) =>
      [
        DateTime.formatIso(DateTime.makeUnsafe(entry.at)),
        entry.event,
        ...Object.entries(entry.fields).map(([key, value]) =>
          typeof value === "string" && /\s/.test(value)
            ? `${key}=${JSON.stringify(value)}`
            : `${key}=${value}`,
        ),
      ].join(" "),
    )
    .join("\n");
}
