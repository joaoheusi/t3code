import type { ActionContextInput, ActionContextResult, PullRequestRef } from "@t3tools/contracts";
import { useThreadShell } from "../state/entities";
import { forkWorkspace } from "../state/forkWorkspace";
import { isPreviewFocused } from "../lib/previewFocus";
import { prepareTask } from "./preparedTasks";
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
  const thread = useThreadShell(typeof target === "string" ? null : target);
  const targetKey = actionTargetKey(target);
  const activeTargetKey = useRef(targetKey);
  useEffect(() => {
    activeTargetKey.current = targetKey;
  }, [targetKey]);
  const [hostContext, setHostContext] = useState<ActionContextResult | null>(null);
  const [repositoryId, setRepositoryId] = useState("");
  const [prIndex, setPrIndex] = useState("");
  const resolveContext = useAtomCommand(forkWorkspace.context, { reportFailure: false });
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.forkQuickActionsVersion === 1;
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const [open, setOpen] = useState(false);
  const [libraryDirty, setLibraryDirty] = useState(false);
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
  const [hasInvocation, setHasInvocation] = useState(false);
  const cancellation = useRef(0);
  const instant = useRef(new Date());
  const list = useEnvironmentQuery(
    open && supported
      ? quickActionsEnvironment.list({ environmentId, input: projectId ? { projectId } : {} })
      : null,
  );
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const actions = rankQuickActions(list.data ?? [], query, recent);
  const cancel = () => {
    if (manage && libraryDirty && !window.confirm("Discard unsaved action changes?")) return;
    if (invocation.current) actionDispatcher.cancel(invocation.current);
    invocation.current = null;
    setHasInvocation(false);
    cancellation.current++;
    setOpen(false);
  };
  const begin = (actionId = "palette") => {
    if (pending.current || isCommandPaletteOpen() || !supported) return false;
    invocation.current = canOperate
      ? actionDispatcher.capture(actionTargetKey(target), actionId, 0)
      : null;
    setHasInvocation(invocation.current !== null);
    instant.current = new Date();
    setError(null);
    setStale(false);
    setSelected(null);
    setValues({});
    setHostContext(null);
    setRepositoryId("");
    setPrIndex("");
    setQuery("");
    setIndex(0);
    setManage(false);
    setOpen(true);
    if (!invocation.current)
      setError("The target composer is unavailable. You can still view the library.");
    return true;
  };
  const choose = async (
    action: QuickAction,
    execute = true,
    bindingId = repositoryId,
    selectedPr = prIndex,
  ) => {
    const capturedTarget = target;
    const capturedKey = targetKey;
    const capturedInvocation = invocation.current;
    const capturedCancellation = cancellation.current;

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
      const contextual =
        fresh.id === "99aa6720-f388-4bbd-aacc-000000000000" ||
        fresh.id === "99aa6720-f388-4bbd-aacc-000000000001";
      let host: ActionContextResult | null = null;
      let contextInput: ActionContextInput | undefined;
      if (
        projectId &&
        (contextual || variables.some((name) => !["date", "time", "clipboard"].includes(name)))
      ) {
        const linked =
          selectedPr !== ""
            ? thread?.pullRequests[Number(selectedPr)]
            : thread?.pullRequests.length === 1
              ? thread.pullRequests[0]
              : undefined;
        const pr: PullRequestRef | undefined = linked
          ? { projectId, host: linked.host, repository: linked.repository, number: linked.number }
          : undefined;
        contextInput = {
          projectId,
          ...(typeof capturedTarget === "string" ? {} : { threadId: capturedTarget.threadId }),
          ...(bindingId ? { bindingId } : {}),
          ...(pr ? { pullRequest: pr } : {}),
        };
        const result = await resolveContext({ environmentId, input: contextInput });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        host = result.value;
        if (host.threadTitle) context["thread.title"] = host.threadTitle;
        context["workspace.repositories"] = host.repositories
          .map(
            (entry) =>
              `${entry.label} · ${entry.mode} · ${entry.repository.path} · ${entry.repository.branch ?? "Detached HEAD"}`,
          )
          .join("\n");
        const repo = bindingId
          ? host.repositories.find((entry) => entry.id === bindingId)
          : host.repositories.length === 1
            ? host.repositories[0]
            : undefined;
        if (repo) {
          context["repo.name"] = repo.label;
          context["repo.path"] = repo.repository.path;
          context["repo.branch"] = repo.repository.branch ?? "Detached HEAD";
        }
        if (host.pullRequest) {
          context["pr.url"] = host.pullRequest.url;
          context["ci.failures"] = host.pullRequest.failures;
        }
      }
      const complete =
        !variables.some((name) => context[name as QuickActionVariable] === undefined) &&
        (!contextual || (host?.pullRequest !== null && host !== null));
      const rendered = complete
        ? renderQuickAction(fresh.template, context) +
          (contextual
            ? `\n\n${fresh.id.endsWith("000000000001") ? host!.pullRequest!.conflicts : host!.pullRequest!.failures}`
            : "")
        : null;
      if (cancellation.current !== capturedCancellation) return;
      if (activeTargetKey.current !== capturedKey) {
        if (rendered && projectId)
          prepareTask(capturedTarget, {
            prompt: rendered,
            validation: {
              environmentId,
              projectId,
              action: { id: fresh.id, revision: fresh.revision },
              ...(contextInput
                ? {
                    context: {
                      ...contextInput,
                      ...(host?.pullRequest?.headSha
                        ? { expectedHeadSha: host.pullRequest.headSha }
                        : {}),
                    },
                    workspaceRevision: host?.workspaceRevision ?? null,
                  }
                : {}),
            },
          });
        return;
      }
      if (capturedInvocation)
        invocation.current = actionDispatcher.select(capturedInvocation, fresh.id, fresh.revision);
      setValues(context);
      setHostContext(host);
      setSelected(fresh);
      if (execute && rendered && invocation.current) {
        const latest = await reload({ environmentId, input: projectId ? { projectId } : {} });
        if (latest._tag === "Failure") throw squashAtomCommandFailure(latest);
        if (
          !latest.value.some(
            (entry) => entry.enabled && entry.id === fresh.id && entry.revision === fresh.revision,
          )
        )
          throw new Error("This action changed while context loaded. Choose it again.");
        if (cancellation.current !== capturedCancellation) return;
        const result = actionDispatcher.insert(
          invocation.current,
          rendered,
          contextual ? "append" : "selection",
        );
        if (result === "inserted") {
          setRecent((previous) =>
            [fresh.id, ...previous.filter((id) => id !== fresh.id)].slice(0, 20),
          );
          cancel();
          return;
        }
        if (
          result === "unavailable-target" &&
          activeTargetKey.current !== capturedKey &&
          projectId
        ) {
          prepareTask(capturedTarget, {
            prompt: rendered,
            validation: {
              environmentId,
              projectId,
              action: { id: fresh.id, revision: fresh.revision },
              ...(contextInput
                ? {
                    context: {
                      ...contextInput,
                      ...(host?.pullRequest?.headSha
                        ? { expectedHeadSha: host.pullRequest.headSha }
                        : {}),
                    },
                    workspaceRevision: host?.workspaceRevision ?? null,
                  }
                : {}),
            },
          });
          return;
        }
        if (result === "stale-draft") setStale(true);
        setError(
          result === "stale-draft"
            ? "The draft changed. Append this text to the current draft or cancel."
            : "The original composer is unavailable. Return to that thread and choose again.",
        );
      }
      if (contextual && !host?.pullRequest)
        setError("Select an associated PR before preparing this task.");
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
      const contextual =
        action.id === "99aa6720-f388-4bbd-aacc-000000000000" ||
        action.id === "99aa6720-f388-4bbd-aacc-000000000001";
      if (contextual && !hostContext?.pullRequest)
        throw new Error("Select an associated PR first.");
      if (hostContext?.pullRequest && projectId) {
        const linked =
          prIndex !== ""
            ? thread?.pullRequests[Number(prIndex)]
            : thread?.pullRequests.length === 1
              ? thread.pullRequests[0]
              : undefined;
        if (!linked) throw new Error("The associated PR is unavailable. Choose again.");
        const refreshed = await resolveContext({
          environmentId,
          input: {
            projectId,
            ...(typeof target === "string" ? {} : { threadId: target.threadId }),
            ...(repositoryId ? { bindingId: repositoryId } : {}),
            pullRequest: {
              projectId,
              host: linked.host,
              repository: linked.repository,
              number: linked.number,
            },
            ...(hostContext.pullRequest.headSha
              ? { expectedHeadSha: hostContext.pullRequest.headSha }
              : {}),
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
        if (refreshed.value.workspaceRevision !== hostContext.workspaceRevision)
          throw new Error("The workspace changed. Choose this action again.");
      }
      const text =
        renderQuickAction(action.template, values) +
        (contextual
          ? `\n\n${action.id.endsWith("000000000001") ? hostContext!.pullRequest!.conflicts : hostContext!.pullRequest!.failures}`
          : "");
      const inserted = actionDispatcher.insert(
        invocation.current,
        text,
        append || contextual ? "append" : "selection",
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
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          previewFocus: isPreviewFocused(),
          terminalOpen,
        },
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
    [targetKey],
  );
  const preview = () =>
    renderQuickAction(selected!.template, values) +
    ((selected?.id === "99aa6720-f388-4bbd-aacc-000000000000" ||
      selected?.id === "99aa6720-f388-4bbd-aacc-000000000001") &&
    hostContext?.pullRequest
      ? `\n\n${selected.id.endsWith("000000000001") ? hostContext.pullRequest.conflicts : hostContext.pullRequest.failures}`
      : "");
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
              <QuickActionLibrary environmentId={environmentId} onDirtyChange={setLibraryDirty} />
            ) : selected ? (
              <>
                <p>Insert editable text into the captured thread. Review it before sending.</p>
                {hostContext && hostContext.repositories.length > 1 ? (
                  <label>
                    Repository
                    <select
                      value={repositoryId}
                      onChange={(event) => {
                        setRepositoryId(event.target.value);
                        void choose(selected, false, event.target.value);
                      }}
                    >
                      <option value="">Choose a repository</option>
                      {hostContext.repositories.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label} · {entry.repository.path}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {thread && thread.pullRequests.length > 1 ? (
                  <label>
                    Pull request
                    <select
                      value={prIndex}
                      onChange={(event) => {
                        setPrIndex(event.target.value);
                        void choose(selected, false, repositoryId, event.target.value);
                      }}
                    >
                      <option value="">Choose a PR</option>
                      {thread.pullRequests.map((pr, index) => (
                        <option key={`${pr.host}:${pr.repository}:${pr.number}`} value={index}>
                          {pr.host}/{pr.repository}#{pr.number}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {hostContext?.notices.map((notice) => (
                  <p key={notice}>{notice}</p>
                ))}
                <pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap">
                  {(() => {
                    try {
                      return preview();
                    } catch {
                      return selected.template;
                    }
                  })()}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    try {
                      void navigator.clipboard
                        .writeText(preview())
                        .catch(() => setError("Clipboard access was denied."));
                    } catch (failure) {
                      setError(String(failure));
                    }
                  }}
                >
                  Copy text
                </Button>
                <Button
                  type="button"
                  disabled={
                    busy ||
                    !canOperate ||
                    !hasInvocation ||
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
                if (manage && libraryDirty && !window.confirm("Discard unsaved action changes?"))
                  return;
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
