import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, MessageId, CommandId, ProjectId } from "@t3tools/contracts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { PendingThreadCreationOutcome } from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { threadCreationGatedDetailAtom } from "./thread-creation-gated-detail";
import { scopedThreadKey } from "../lib/scopedEntities";

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("new-thread") };
const key = scopedThreadKey(ref.environmentId, ref.threadId);
const message: QueuedThreadMessage = {
  ...ref,
  messageId: MessageId.make("message"),
  commandId: CommandId.make("command"),
  text: "Create this thread",
  attachments: [],
  createdAt: "2026-10-08T21:53:33.000Z",
  creation: {
    projectId: ProjectId.make("project"),
    workspaceMode: "worktree",
    branch: null,
    worktreePath: null,
  },
};

describe("thread creation detail subscriptions", () => {
  it("keeps a rejected creation blocked after its outbox entry is removed", () => {
    const registry = AtomRegistry.make();
    let loads = 0;
    const outcomesAtom = Atom.make<Readonly<Record<string, PendingThreadCreationOutcome>>>({
      [key]: { kind: "failed", message, reason: "Worktree setup failed" },
    });
    const gated = threadCreationGatedDetailAtom({
      ref,
      detailAtom: Atom.make(() => {
        loads += 1;
        return AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
      }),
      shellAtom: Atom.make<EnvironmentThreadShell | null>(null),
      queuedMessagesAtom: Atom.make({}),
      outcomesAtom,
    });
    try {
      registry.get(gated);
      expect(loads).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it("loads an existing thread without requiring a shell or a creation receipt", () => {
    const registry = AtomRegistry.make();
    let loads = 0;
    const { creation: _creation, ...followUp } = message;
    const gated = threadCreationGatedDetailAtom({
      ref,
      detailAtom: Atom.make(() => {
        loads += 1;
        return AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE);
      }),
      shellAtom: Atom.make<EnvironmentThreadShell | null>(null),
      queuedMessagesAtom: Atom.make({ [key]: [followUp] }),
      outcomesAtom: Atom.make({}),
    });
    try {
      registry.get(gated);
      expect(loads).toBe(1);
    } finally {
      registry.dispose();
    }
  });

  it.each(["shell", "receipt"] as const)(
    "waits for the %s before any detail reader loads the new thread",
    (confirmation) => {
      const registry = AtomRegistry.make();
      let serverCreated = false;
      let loads = 0;
      const queuedMessagesAtom = Atom.make<Record<string, ReadonlyArray<QueuedThreadMessage>>>({
        [key]: [message],
      });
      const outcomesAtom = Atom.make<Readonly<Record<string, PendingThreadCreationOutcome>>>({});
      const shellAtom = Atom.make<EnvironmentThreadShell | null>(null);
      // Like the snapshot loader, an early read returns a terminal missing result.
      const detailAtom = Atom.make(() => {
        loads += 1;
        return AsyncResult.success({
          ...EMPTY_ENVIRONMENT_THREAD_STATE,
          status: serverCreated ? ("live" as const) : ("deleted" as const),
        });
      });
      const gated = threadCreationGatedDetailAtom({
        ref,
        detailAtom,
        shellAtom,
        queuedMessagesAtom,
        outcomesAtom,
      });
      const modelReader = Atom.make((get) => get(gated));
      const queueReader = Atom.make((get) => get(gated));
      try {
        const unmountModel = registry.mount(modelReader);
        const unmountQueue = registry.mount(queueReader);
        expect(loads).toBe(0);
        serverCreated = true;
        if (confirmation === "receipt") {
          registry.set(outcomesAtom, { [key]: { kind: "delivered", message } });
        } else {
          registry.set(shellAtom, {
            id: ref.threadId,
            environmentId: ref.environmentId,
          } as EnvironmentThreadShell);
        }
        expect(AsyncResult.getOrThrow(registry.get(gated)).status).toBe("live");
        expect(loads).toBe(1);
        registry.set(queuedMessagesAtom, {});
        unmountModel();
        unmountQueue();
        // Reopening uses the loaded thread, never a premature deleted result.
        expect(AsyncResult.getOrThrow(registry.get(gated)).status).toBe("live");
      } finally {
        registry.dispose();
      }
    },
  );
});
