import type { ActionContextInput, EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import type { ComposerThreadTarget } from "../composerDraftStore";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { actionTargetKey } from "./dispatcher";

/** Text that could not be inserted where it was requested. It waits on that thread's composer. */
export interface PreparedTask {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly reviewComments?: readonly ReviewCommentContext[];
  /** PR evidence is re-checked against the PR head before insertion. */
  readonly validation?: {
    readonly environmentId: EnvironmentId;
    readonly context: ActionContextInput;
  };
  readonly createdAt: number;
}

const EXPIRY_MS = 5 * 60_000;
const tasks = new Map<string, PreparedTask>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
let sequence = 0;

export function prepareTask(
  target: ComposerThreadTarget,
  task: Omit<PreparedTask, "id" | "createdAt">,
) {
  const now = Date.now();
  for (const [key, entry] of tasks) if (now - entry.createdAt > EXPIRY_MS) tasks.delete(key);
  if (tasks.size >= 100) tasks.delete(tasks.keys().next().value!);
  tasks.set(actionTargetKey(target), { ...task, id: String(++sequence), createdAt: now });
  notify();
}

export function dismissPreparedTask(target: ComposerThreadTarget, id: string) {
  if (tasks.get(actionTargetKey(target))?.id !== id) return;
  tasks.delete(actionTargetKey(target));
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function readPreparedTask(target: ComposerThreadTarget): PreparedTask | null {
  const task = tasks.get(actionTargetKey(target)) ?? null;
  return task && Date.now() - task.createdAt <= EXPIRY_MS ? task : null;
}

export function usePreparedTask(target: ComposerThreadTarget | null) {
  return useSyncExternalStore(subscribe, () => (target ? readPreparedTask(target) : null));
}
