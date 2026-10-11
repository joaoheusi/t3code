import { describe, expect, it } from "@effect/vitest";
import { ActionDispatcher, type ActionEditor } from "./dispatcher.ts";

describe("action insertion", () => {
  function setup() {
    let text = "before SELECT after",
      revision = 0,
      ready = true,
      clock = 0,
      sends = 0;
    const replacements: string[] = [];
    const editor: ActionEditor = {
      read: () => ({ text, revision, selection: { start: 7, end: 13 } }),
      available: () => ready,
      replace: (start, end, value) => {
        text = text.slice(0, start) + value + text.slice(end);
        revision++;
        replacements.push(text);
        return true;
      },
      submit: () => {
        sends++;
        return true;
      },
    };
    let sequence = 0;
    const dispatcher = new ActionDispatcher(
      () => clock,
      () => String(++sequence),
    );
    const unregister = dispatcher.register("host:original", editor);
    return {
      dispatcher,
      unregister,
      replacements,
      text: () => text,
      sends: () => sends,
      change: () => {
        text = "new user edits";
        revision++;
      },
      unavailable: () => {
        ready = false;
      },
      expire: () => {
        clock = 300001;
      },
    };
  }
  it("replaces only the captured selection and consumes an invocation once", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    expect(state.dispatcher.insert(invocation, "inserted", "selection")).toBe("inserted");
    expect(state.text()).toBe("before inserted after");
    expect(state.dispatcher.insert(invocation, "again", "append")).toBe("already-inserted");
    expect(state.replacements).toHaveLength(1);
  });
  it("preserves edits while context loads and requires explicit append", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    state.change();
    expect(state.dispatcher.insert(invocation, "task", "selection")).toBe("stale-draft");
    expect(state.text()).toBe("new user edits");
    expect(state.dispatcher.insert(invocation, "task", "selection", true)).toBe("inserted");
    expect(state.text()).toBe("new user edits\n\ntask");
  });
  it("never retargets on navigation and retains a prepared task for the original destination", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    state.unregister();
    let other = "other";
    state.dispatcher.register("host:other", {
      read: () => ({ text: other, revision: 0, selection: { start: 0, end: 0 } }),
      available: () => true,
      replace: () => {
        other = "wrong";
        return true;
      },
      submit: () => {
        other = "sent";
        return true;
      },
    });
    expect(state.dispatcher.insert(invocation, "task", "append")).toBe("unavailable-target");
    expect(state.dispatcher.submit(invocation)).toBe(false);
    expect(other).toBe("other");
  });
  it("sends only after its own insertion into a still-available composer", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    expect(state.dispatcher.submit(invocation)).toBe(false);
    expect(state.dispatcher.insert(invocation, "inserted", "selection")).toBe("inserted");
    state.unavailable();
    expect(state.dispatcher.submit(invocation)).toBe(false);
    expect(state.sends()).toBe(0);
    const ready = setup(),
      sent = ready.dispatcher.capture("host:original", "action", 1)!;
    ready.dispatcher.insert(sent, "inserted", "selection");
    expect(ready.dispatcher.submit(sent)).toBe(true);
    expect(ready.dispatcher.submit(sent)).toBe(false);
    expect(ready.sends()).toBe(1);
  });
  it("never sends through an editor that replaced the one it inserted into", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    state.dispatcher.insert(invocation, "inserted", "selection");
    let replacementSends = 0;
    state.dispatcher.register("host:original", {
      read: () => ({ text: "", revision: 0, selection: { start: 0, end: 0 } }),
      available: () => true,
      replace: () => true,
      submit: () => {
        replacementSends++;
        return true;
      },
    });
    expect(state.dispatcher.submit(invocation)).toBe(false);
    expect(replacementSends).toBe(0);
    expect(state.sends()).toBe(0);
  });
  it("allows a retry after a blocked send", () => {
    let allowSend = false,
      sends = 0;
    const dispatcher = new ActionDispatcher(
      () => 0,
      () => "1",
    );
    dispatcher.register("host:original", {
      read: () => ({ text: "", revision: 0, selection: { start: 0, end: 0 } }),
      available: () => true,
      replace: () => true,
      submit: () => {
        if (allowSend) sends++;
        return allowSend;
      },
    });
    const invocation = dispatcher.capture("host:original", "action", 1)!;
    dispatcher.insert(invocation, "inserted", "selection");
    expect(dispatcher.submit(invocation)).toBe(false);
    allowSend = true;
    expect(dispatcher.submit(invocation)).toBe(true);
    expect(dispatcher.submit(invocation)).toBe(false);
    expect(sends).toBe(1);
  });
  it("cancels and expires without modifying the editor", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    state.expire();
    expect(state.dispatcher.insert(invocation, "task", "append")).toBe("expired");
    expect(state.replacements).toHaveLength(0);
  });
  it("blocks unavailable editors and never changes the draft on cancellation", () => {
    const state = setup(),
      invocation = state.dispatcher.capture("host:original", "action", 1)!;
    state.dispatcher.cancel(invocation);
    expect(state.dispatcher.insert(invocation, "task", "append")).toBe("expired");
    state.unavailable();
    expect(state.dispatcher.capture("host:original", "action", 1)).toBeNull();
    expect(state.replacements).toHaveLength(0);
  });
});
