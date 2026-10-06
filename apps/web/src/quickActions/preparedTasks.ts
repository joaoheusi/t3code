import { useSyncExternalStore } from "react";
import type { ComposerThreadTarget } from "../composerDraftStore";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { actionTargetKey } from "./dispatcher";
export interface PreparedTask {
  readonly id: string;
  readonly prompt: string;
  readonly reviewComments?: readonly ReviewCommentContext[];
  readonly createdAt: number;
}
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
  for (const [key, entry] of tasks) if (now - entry.createdAt > 300000) tasks.delete(key);
  if (tasks.size >= 100) tasks.delete(tasks.keys().next().value!);
  tasks.set(actionTargetKey(target), { ...task, id: String(++sequence), createdAt: now });
  notify();
}
export function dismissPreparedTask(target: ComposerThreadTarget, id: string) {
  if (tasks.get(actionTargetKey(target))?.id === id) {
    tasks.delete(actionTargetKey(target));
    notify();
  }
}
export function usePreparedTask(target: ComposerThreadTarget) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => tasks.get(actionTargetKey(target)) ?? null,
  );
}
