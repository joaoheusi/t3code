export interface ActionEditorSnapshot {
  readonly revision: number;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
}
export interface ActionEditor {
  readonly read: () => ActionEditorSnapshot;
  readonly available: () => boolean;
  readonly replace: (start: number, end: number, text: string) => boolean;
}
export interface ActionInvocation {
  readonly id: string;
  readonly target: string;
  readonly actionId: string;
  readonly actionRevision: number;
  readonly capturedAt: number;
  readonly draft: ActionEditorSnapshot;
}
export type ActionInsertionResult =
  | "inserted"
  | "stale-draft"
  | "unavailable-target"
  | "expired"
  | "already-inserted";

/** The dispatcher owns insertion only. It has no provider, thread-create, or Git dependency. */
export class ActionDispatcher {
  private readonly editors = new Map<string, ActionEditor>();
  private readonly invocations = new Map<
    string,
    { invocation: ActionInvocation; consumed: boolean }
  >();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly nextId: () => string = () => crypto.randomUUID(),
  ) {}
  register(target: string, editor: ActionEditor): () => void {
    this.editors.set(target, editor);
    return () => {
      if (this.editors.get(target) === editor) this.editors.delete(target);
    };
  }
  capture(target: string, actionId: string, actionRevision: number): ActionInvocation | null {
    const editor = this.editors.get(target);
    if (!editor?.available()) return null;
    for (const [id, record] of this.invocations) {
      if (this.now() - record.invocation.capturedAt > 300000) this.invocations.delete(id);
    }
    if (this.invocations.size >= 100) return null;
    const invocation = {
      id: this.nextId(),
      target,
      actionId,
      actionRevision,
      capturedAt: this.now(),
      draft: editor.read(),
    };
    this.invocations.set(invocation.id, { invocation, consumed: false });
    return invocation;
  }
  cancel(invocation: ActionInvocation): void {
    this.invocations.delete(invocation.id);
  }
  insert(
    invocation: ActionInvocation,
    text: string,
    mode: "selection" | "append",
    appendToChangedDraft = false,
  ): ActionInsertionResult {
    const record = this.invocations.get(invocation.id);
    if (!record || record.invocation !== invocation || this.now() - invocation.capturedAt > 300000)
      return "expired";
    if (record.consumed) return "already-inserted";
    const editor = this.editors.get(invocation.target);
    if (!editor?.available()) return "unavailable-target";
    const current = editor.read();
    if (current.revision !== invocation.draft.revision && !appendToChangedDraft)
      return "stale-draft";
    const append = mode === "append" || appendToChangedDraft;
    const { start, end } = append
      ? { start: current.text.length, end: current.text.length }
      : invocation.draft.selection;
    if (start < 0 || end < start || end > current.text.length) return "stale-draft";
    const insertion = append && current.text.length > 0 ? `\n\n${text}` : text;
    // Claim before calling the editor to prevent synchronous re-entry. A rejected editor permits a deliberate retry.
    record.consumed = true;
    if (!editor.replace(start, end, insertion)) {
      record.consumed = false;
      return "unavailable-target";
    }
    return "inserted";
  }
}
