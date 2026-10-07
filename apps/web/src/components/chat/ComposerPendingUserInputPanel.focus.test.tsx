// @vitest-environment jsdom

import { RuntimeRequestId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let root: Root;
let form: HTMLFormElement;
let editor: HTMLDivElement;
let panelHost: HTMLDivElement;
let outsideInput: HTMLInputElement;
let mobileViewport = false;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: mobileViewport && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // Mirrors the composer: the editor and the question panel share one form,
  // while other inputs on the page live outside it.
  form = document.createElement("form");
  editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  panelHost = document.createElement("div");
  form.append(editor, panelHost);
  outsideInput = document.createElement("input");
  document.body.append(form, outsideInput);
  root = createRoot(panelHost);
});

afterEach(async () => {
  await act(async () => root.unmount());
  form.remove();
  outsideInput.remove();
  mobileViewport = false;
  vi.unstubAllGlobals();
});

async function renderPanel(props: {
  questionIndex?: number;
  answers?: Record<string, PendingUserInputDraftAnswer>;
  onToggleOption?: (questionId: string, optionValue: string) => void;
  onAdvance?: () => void;
  onPrevious?: () => void;
  respondingRequestIds?: RuntimeRequestId[];
}) {
  await act(async () => {
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        respondingRequestIds={props.respondingRequestIds ?? []}
        answers={props.answers ?? {}}
        questionIndex={props.questionIndex ?? 0}
        onToggleOption={props.onToggleOption ?? (() => {})}
        onAdvance={props.onAdvance ?? (() => {})}
        onPrevious={props.onPrevious ?? (() => {})}
        onDismiss={() => {}}
      />,
    );
  });
}

async function pressKey(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

function optionButtons(): HTMLButtonElement[] {
  return Array.from(
    panelHost.querySelectorAll<HTMLButtonElement>("button:not([data-pending-user-input-toggle])"),
  );
}

describe("ComposerPendingUserInputPanel focus", () => {
  it("moves focus from the composer editor onto the first option so digit shortcuts work", async () => {
    editor.focus();
    expect(document.activeElement).toBe(editor);
    const onToggleOption = vi.fn();

    await renderPanel({ onToggleOption });

    expect(document.activeElement).toBe(optionButtons()[0]);

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }),
      );
    });
    expect(onToggleOption).toHaveBeenCalledWith("question-1", "Big bang");
  });

  it("takes focus when nothing is focused", async () => {
    expect(document.activeElement).toBe(document.body);

    await renderPanel({});

    expect(document.activeElement).toBe(optionButtons()[0]);
  });

  it("refocuses the first option when the prompt advances to its next question", async () => {
    await renderPanel({});
    const firstQuestionOption = optionButtons()[0];
    expect(document.activeElement).toBe(firstQuestionOption);

    await renderPanel({ questionIndex: 1 });

    const nextOption = optionButtons()[0];
    expect(nextOption?.textContent).toContain("Canary");
    expect(document.activeElement).toBe(nextOption);
  });

  it("leaves focus alone when it is in a field outside the composer", async () => {
    outsideInput.focus();

    await renderPanel({});

    expect(document.activeElement).toBe(outsideInput);
  });

  it("leaves focus alone while the prompt cannot be answered", async () => {
    editor.focus();

    await renderPanel({ respondingRequestIds: [prompt.requestId] });

    expect(document.activeElement).toBe(editor);
  });

  it("leaves the phone editor focused since it has no digit shortcuts", async () => {
    mobileViewport = true;
    editor.focus();

    await renderPanel({});

    expect(document.activeElement).toBe(editor);
  });

  it("refocuses the selected option rather than the first", async () => {
    await renderPanel({ answers: { "question-1": { selectedOptionValues: ["Big bang"] } } });
    editor.focus();

    expect(focusPendingUserInputOption(form)).toBe(true);
    expect(document.activeElement).toBe(optionButtons()[1]);
  });

  it("moves between options with the up and down arrows, wrapping at the ends", async () => {
    await renderPanel({});
    const [first, second] = optionButtons();

    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(second);
    await pressKey("ArrowDown");
    expect(document.activeElement).toBe(first);
    await pressKey("ArrowUp");
    expect(document.activeElement).toBe(second);
  });

  it("moves between questions with the left and right arrows", async () => {
    const onAdvance = vi.fn();
    const onPrevious = vi.fn();

    await renderPanel({ onAdvance, onPrevious });
    await pressKey("ArrowRight");
    await pressKey("ArrowLeft");
    // Unanswered first question: right does not skip it, left has nowhere to go.
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();

    await renderPanel({
      answers: { "question-1": { selectedOptionValues: ["Incremental"] } },
      onAdvance,
      onPrevious,
    });
    await pressKey("ArrowRight");
    expect(onAdvance).toHaveBeenCalledTimes(1);

    await renderPanel({ questionIndex: 1, onAdvance, onPrevious });
    await pressKey("ArrowLeft");
    expect(onPrevious).toHaveBeenCalledTimes(1);
    // Right on the last question never submits.
    await renderPanel({
      questionIndex: 1,
      answers: { "question-2": { selectedOptionValues: ["Canary"] } },
      onAdvance,
      onPrevious,
    });
    await pressKey("ArrowRight");
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});
