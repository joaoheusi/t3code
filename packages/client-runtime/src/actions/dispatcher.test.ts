import { describe, expect, it } from "vitest";
import { ActionDispatcher, type ActionEditor } from "./dispatcher.ts";

describe("action insertion", () => {
  function setup() {
    let text = "before SELECT after",
      revision = 0,
      ready = true,
      clock = 0;
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
    };
    const dispatcher = new ActionDispatcher(
      () => clock,
      () => String(Math.random()),
    );
    const unregister = dispatcher.register("host:original", editor);
    return {
      dispatcher,
      unregister,
      replacements,
      text: () => text,
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
    });
    expect(state.dispatcher.insert(invocation, "task", "append")).toBe("unavailable-target");
    expect(other).toBe("other");
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
