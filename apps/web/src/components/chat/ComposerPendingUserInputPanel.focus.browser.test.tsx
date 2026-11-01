import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, render, stubGlobal } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerPendingUserInputPanel,
  focusPendingUserInputOption,
} from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
    {
      id: "question-2",
      header: "Rollout",
      question: "How should the change roll out?",
      options: [
        { label: "Canary", description: "A small slice first" },
        { label: "Everyone", description: "All users at once" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

function setup(mobile = false) {
  const viewport = stubGlobal("matchMedia", (query: string) => ({
    matches: mobile && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const form = document.createElement("form");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  const panelHost = document.createElement("div");
  form.append(editor, panelHost);
  const outsideInput = document.createElement("input");
  document.body.append(form, outsideInput);
  const optionButtons = () =>
    Array.from(
      panelHost.querySelectorAll<HTMLButtonElement>("button:not([data-pending-user-input-toggle])"),
    );
  return {
    form,
    editor,
    panelHost,
    outsideInput,
    optionButtons,
    [Symbol.dispose]() {
      form.remove();
      outsideInput.remove();
      viewport[Symbol.dispose]();
    },
  };
}

function panel(props: {
  questionIndex?: number;
  answers?: Record<string, PendingUserInputDraftAnswer>;
  onToggleOption?: (questionId: string, optionValue: string) => void;
  onAdvance?: () => void;
  onPrevious?: () => void;
  respondingRequestIds?: RuntimeRequestId[];
}) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
      respondingRequestIds={props.respondingRequestIds ?? []}
      answers={props.answers ?? {}}
      questionIndex={props.questionIndex ?? 0}
      onToggleOption={props.onToggleOption ?? (() => {})}
      onAdvance={props.onAdvance ?? (() => {})}
      onPrevious={props.onPrevious ?? (() => {})}
      onDismiss={() => {}}
    />
  );
}

async function pressKey(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("ComposerPendingUserInputPanel focus", () => {
  it("moves focus from the composer editor onto the first option so digit shortcuts work", async () => {
    using fixture = setup();
    const { panelHost, editor, optionButtons } = fixture;
    editor.focus();
    expect(document.activeElement).toBe(editor);
    const onToggleOption = vi.fn();

    await using _screen = await render(panel({ onToggleOption }), { container: panelHost });

    expect(document.activeElement).toBe(optionButtons()[0]);

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }),
      );
    });
    expect(onToggleOption).toHaveBeenCalledWith("question-1", "Big bang");
  });

  it("takes focus when nothing is focused", async () => {
    using fixture = setup();
    const { panelHost, optionButtons } = fixture;
    expect(document.activeElement).toBe(document.body);

    await using _screen = await render(panel({}), { container: panelHost });

    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it("refocuses the first option when the prompt advances to its next question", async () => {
    using fixture = setup();
    const { panelHost, optionButtons } = fixture;
    await using screen = await render(panel({}), { container: panelHost });
    const firstQuestionOption = optionButtons()[0];
    expect(document.activeElement).toBe(firstQuestionOption);

    await screen.rerender(panel({ questionIndex: 1 }));

    const nextOption = optionButtons()[0];
    expect(nextOption?.textContent).toContain("Canary");
    expect(document.activeElement).toBe(nextOption);
  });

  it("leaves focus alone when it is in a field outside the composer", async () => {
    using fixture = setup();
    const { panelHost, outsideInput } = fixture;
    outsideInput.focus();

    await using _screen = await render(panel({}), { container: panelHost });

    expect(document.activeElement).toBe(outsideInput);
  });

  it("leaves focus alone while the prompt cannot be answered", async () => {
    using fixture = setup();
    const { panelHost, editor } = fixture;
    editor.focus();

    await using _screen = await render(panel({ respondingRequestIds: [prompt.requestId] }), {
      container: panelHost,
    });

    expect(document.activeElement).toBe(editor);
  });

  it("leaves the phone editor focused since it has no digit shortcuts", async () => {
    using fixture = setup(true);
    const { panelHost, editor } = fixture;
    editor.focus();

    await using _screen = await render(panel({}), { container: panelHost });

    expect(document.activeElement).toBe(editor);
  });

  it("refocuses the selected option rather than the first", async () => {
    using fixture = setup();
    const { panelHost, editor, form, optionButtons } = fixture;
    await using _screen = await render(
      panel({ answers: { "question-1": { selectedOptionValues: ["Big bang"] } } }),
      { container: panelHost },
    );
    editor.focus();

    expect(focusPendingUserInputOption(form)).toBe(true);
    expect(document.activeElement).toBe(optionButtons()[1]);
  });

  it("moves between options with the up and down arrows, wrapping at the ends", async () => {
    using fixture = setup();
    const { panelHost, optionButtons } = fixture;
    await using _screen = await render(panel({}), { container: panelHost });
    const [first, second] = optionButtons();

    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(second);
    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(first);
    await pressKey("ArrowUp");
    expect(document.activeElement).toBe(second);
  });

  it("moves between questions with the left and right arrows", async () => {
    using fixture = setup();
    const { panelHost } = fixture;
    const onAdvance = vi.fn();
    const onPrevious = vi.fn();

    await using screen = await render(panel({ onAdvance, onPrevious }), { container: panelHost });
    await pressKey("ArrowRight");
    await pressKey("ArrowLeft");
    // Unanswered first question: right does not skip it, left has nowhere to go.
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();

    await screen.rerender(
      panel({
        answers: { "question-1": { selectedOptionValues: ["Incremental"] } },
        onAdvance,
        onPrevious,
      }),
    );
    await pressKey("ArrowRight");
    expect(onAdvance).toHaveBeenCalledTimes(1);

    await screen.rerender(panel({ questionIndex: 1, onAdvance, onPrevious }));
    await pressKey("ArrowLeft");
    expect(onPrevious).toHaveBeenCalledTimes(1);
    // Right on the last question never submits.
    await screen.rerender(
      panel({
        questionIndex: 1,
        answers: { "question-2": { selectedOptionValues: ["Canary"] } },
        onAdvance,
        onPrevious,
      }),
    );
    await pressKey("ArrowRight");
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});
