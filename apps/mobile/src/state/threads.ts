import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { threadOutboxManager } from "./thread-outbox";
import { threadCreationGatedDetailAtom } from "./thread-creation-gated-detail";

export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});
const remoteEnvironmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
const detailAtoms = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((threadId: ThreadId) => {
    const ref = { environmentId, threadId };
    return threadCreationGatedDetailAtom({
      ref,
      detailAtom: remoteEnvironmentThreads.stateAtom(environmentId, threadId),
      shellAtom: environmentThreadShells.threadShellAtom(ref),
      queuedMessagesAtom: threadOutboxManager.queuedMessagesByThreadKeyAtom,
      outcomesAtom: pendingThreadCreationOutcomesAtom,
    });
  }),
);
export const environmentThreads = {
  stateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
    detailAtoms(environmentId)(threadId),
};
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}
