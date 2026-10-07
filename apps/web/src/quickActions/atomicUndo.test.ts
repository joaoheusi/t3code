import { describe, expect, it } from "@effect/vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import { runAtomicEditorEdit } from "../composer-undo-grouping";
const schema = new Schema({ nodes: { doc: { content: "text*" }, text: {} } });
describe("quick action editor history", () => {
  it("undoes one insertion while preserving prior typing and subsequent edits", () => {
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.text("draft")]),
      plugins: [history()],
    });
    const dispatch = (transaction: Transaction) => {
      state = state.apply(transaction);
    };
    dispatch(state.tr.insertText(" typed", 5));
    const view = {
      get state() {
        return state;
      },
      dispatch,
    };
    runAtomicEditorEdit(view, () => {
      dispatch(
        state.tr.replaceWith(0, state.doc.content.size, schema.text("draft typed\n\nResolve CI")),
      );
    });
    dispatch(state.tr.insertText(" later", state.doc.content.size));
    expect(undo(state, dispatch)).toBe(true);
    expect(state.doc.textContent).toBe("draft typed\n\nResolve CI");
    expect(undo(state, dispatch)).toBe(true);
    expect(state.doc.textContent).toBe("draft typed");
    expect(undo(state, dispatch)).toBe(true);
    expect(state.doc.textContent).toBe("draft");
    expect(redo(state, dispatch)).toBe(true);
    expect(state.doc.textContent).toBe("draft typed");
  });
});
