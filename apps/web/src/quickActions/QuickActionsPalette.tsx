import { useEnvironmentOperateAccess } from "../hooks/useEnvironmentOperateAccess";
import { useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  QuickAction,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import type { ActionInvocation } from "@t3tools/client-runtime/actions/dispatcher";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  rankQuickActions,
  renderQuickAction,
  templateVariables,
  type QuickActionVariable,
} from "@t3tools/shared/quickActions";
import type { ComposerThreadTarget } from "../composerDraftStore";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { quickActionsEnvironment } from "../state/quickActions";
import { resolveShortcutCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { actionDispatcher, actionTargetKey } from "./dispatcher";
import { QuickActionLibrary } from "./QuickActionLibrary";

export function QuickActionsPalette({
  environmentId,
  target,
  projectId,
  keybindings,
  terminalOpen,
}: {
  environmentId: EnvironmentId;
  target: ComposerThreadTarget;
  projectId: ProjectId | null;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
}) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.forkQuickActionsVersion === 1;
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<QuickAction | null>(null);
  const [values, setValues] = useState<Partial<Record<QuickActionVariable, string>>>({});
  const [recent, setRecent] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const invocation = useRef<ActionInvocation | null>(null);
  const instant = useRef(new Date());
  const list = useEnvironmentQuery(
    open && supported
      ? quickActionsEnvironment.list({ environmentId, input: projectId ? { projectId } : {} })
      : null,
  );
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const actions = rankQuickActions(list.data ?? [], query, recent);
  const cancel = () => {
    if (invocation.current) actionDispatcher.cancel(invocation.current);
    invocation.current = null;
    setOpen(false);
  };
  const begin = (actionId = "palette") => {
    if (pending.current || isCommandPaletteOpen() || !supported) return false;
    invocation.current = canOperate
      ? actionDispatcher.capture(actionTargetKey(target), actionId, 0)
      : null;
    instant.current = new Date();
    setError(null);
    setStale(false);
    setSelected(null);
    setValues({});
    setQuery("");
    setIndex(0);
    setManage(false);
    setOpen(true);
    if (!invocation.current)
      setError("The target composer is unavailable. You can still view the library.");
    return true;
  };
  const choose = async (action: QuickAction) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await reload({ environmentId, input: projectId ? { projectId } : {} });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const fresh = result.value.find((entry) => entry.id === action.id && entry.enabled);
      if (!fresh || fresh.revision !== action.revision)
        throw new Error("This action changed or was deleted. Reload the library and choose again.");
      const variables = templateVariables(fresh.template);
      const context: Partial<Record<QuickActionVariable, string>> = {
        date: instant.current.toLocaleDateString(),
        time: instant.current.toLocaleTimeString(),
      };
      if (variables.includes("clipboard")) context.clipboard = await navigator.clipboard.readText();
      setValues(context);
      setSelected(fresh);
      // Host context is resolved only from validated workspace/PR data. Never guess paths or logs.
      if (variables.some((name) => context[name as QuickActionVariable] === undefined))
        setError(
          "Required thread, repository, or PR context is unavailable. Select an associated context before using this template.",
        );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load the action or read the clipboard.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const insert = async (append = false) => {
    if (!selected || !invocation.current || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await reload({ environmentId, input: projectId ? { projectId } : {} });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const action = result.value.find((entry) => entry.id === selected.id && entry.enabled);
      if (!action || action.revision !== selected.revision)
        throw new Error("This action changed. Cancel and choose it again.");
      const text = renderQuickAction(action.template, values);
      const inserted = actionDispatcher.insert(
        invocation.current,
        text,
        append ? "append" : "selection",
        append,
      );
      if (inserted === "stale-draft") {
        setStale(true);
        throw new Error("The draft changed. Append this text to the current draft or cancel.");
      }
      if (inserted !== "inserted")
        throw new Error(
          "The original target is unavailable or this invocation expired. Return to that thread and open Quick actions again.",
        );
      setRecent((previous) =>
        [action.id, ...previous.filter((id) => id !== action.id)].slice(0, 20),
      );
      cancel();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not insert the action.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null, terminalOpen },
      });
      if (
        command !== "quickActions.toggle" &&
        !(command?.startsWith("quickAction.") && command.endsWith(".insert"))
      )
        return;
      // These use the existing resolver and its when-clause. No separate accelerator registry.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || open || isCommandPaletteOpen()) return;
      const id = command === "quickActions.toggle" ? null : command.slice(12, -7);
      if (!begin(id ?? "palette") || !id) return;
      void reload({ environmentId, input: projectId ? { projectId } : {} }).then((result) => {
        if (result._tag === "Failure") {
          setError("This environment's action library is unavailable.");
          return;
        }
        const action = result.value.find((entry) => entry.id === id && entry.enabled);
        if (action) void choose(action);
        else setError("This shortcut's action is missing or disabled on this environment.");
      });
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });
  useEffect(
    () => () => {
      if (invocation.current) actionDispatcher.cancel(invocation.current);
    },
    [target],
  );
  if (!supported) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => begin()}
      >
        Quick actions
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) cancel();
        }}
      >
        <DialogPopup
          data-quick-actions
          onKeyDown={(event) => {
            event.stopPropagation();
            if (manage || selected || event.target instanceof HTMLTextAreaElement) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, actions.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter" && actions[index]) {
              event.preventDefault();
              void choose(actions[index]);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {manage ? "Manage quick actions" : selected ? selected.name : "Quick actions"}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {error || list.error ? <p role="alert">{error ?? list.error}</p> : null}
            {manage ? (
              <QuickActionLibrary environmentId={environmentId} />
            ) : selected ? (
              <>
                <p>Insert editable text into the captured thread. Review it before sending.</p>
                <pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap">
                  {(() => {
                    try {
                      return renderQuickAction(selected.template, values);
                    } catch {
                      return selected.template;
                    }
                  })()}
                </pre>
                <Button
                  type="button"
                  disabled={
                    busy ||
                    !invocation.current ||
                    templateVariables(selected.template).some(
                      (name) => values[name as QuickActionVariable] === undefined,
                    )
                  }
                  onClick={() => void insert(stale)}
                >
                  {stale ? "Append to current draft" : "Insert"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSelected(null);
                    setError(null);
                    setStale(false);
                  }}
                >
                  Back
                </Button>
              </>
            ) : (
              <>
                <Input
                  autoFocus
                  aria-label="Search quick actions"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setIndex(0);
                  }}
                />
                <div role="listbox" aria-label="Quick actions" className="my-3 grid gap-2">
                  {actions.map((action, i) => (
                    <Button
                      key={action.id}
                      type="button"
                      role="option"
                      aria-selected={index === i}
                      variant={index === i ? "secondary" : "ghost"}
                      disabled={busy}
                      onClick={() => void choose(action)}
                    >
                      <span className="min-w-0 text-left">
                        <span className="block">
                          {action.favorite ? "★ " : ""}
                          {action.name} · {action.projectId ? "Project" : "Environment"}
                        </span>
                        <span className="block truncate text-xs">{action.description}</span>
                      </span>
                    </Button>
                  ))}
                  {actions.length === 0 ? (
                    <p>{list.isPending ? "Loading…" : "No matching actions."}</p>
                  ) : null}
                </div>
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setManage(!manage);
                setSelected(null);
              }}
            >
              {" "}
              {manage ? "Palette" : "Manage"}
            </Button>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
