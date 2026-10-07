// @vitest-environment jsdom

import { RuntimeRequestId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

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
  onToggleOption?: (questionId: string, optionValue: string) => void;
  respondingRequestIds?: RuntimeRequestId[];
}) {
  await act(async () => {
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        respondingRequestIds={props.respondingRequestIds ?? []}
        answers={{}}
        questionIndex={props.questionIndex ?? 0}
        onToggleOption={props.onToggleOption ?? (() => {})}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />,
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
});
