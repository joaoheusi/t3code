import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import type { PendingThreadCreationOutcome } from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

export function threadCreationGatedDetailAtom<E>(input: {
  readonly ref: ScopedThreadRef;
  readonly detailAtom: Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
  readonly shellAtom: Atom.Atom<EnvironmentThreadShell | null>;
  readonly queuedMessagesAtom: Atom.Atom<
    Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>
  >;
  readonly outcomesAtom: Atom.Atom<Readonly<Record<string, PendingThreadCreationOutcome>>>;
}) {
  const key = scopedThreadKey(input.ref.environmentId, input.ref.threadId);
  return Atom.make((get) => {
    if (get(input.shellAtom) === null) {
      const outcome = get(input.outcomesAtom)[key];
      const queuedCreation = get(input.queuedMessagesAtom)[key]?.some(
        (message) => message.creation !== undefined,
      );
      // Every detail consumer shares this gate, including model and queue badges.
      // An optimistic shell is visible before the server can answer a snapshot.
      if (outcome?.kind !== "delivered" && (queuedCreation || outcome !== undefined)) {
        return AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
      }
    }
    return get(input.detailAtom);
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`mobile-thread-detail:${key}`));
}
