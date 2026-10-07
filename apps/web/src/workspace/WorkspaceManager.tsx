import type { ProjectReadFileResult, ProjectSearchEntriesResult } from "@t3tools/contracts";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type WorkspaceBindingRequest,
  type WorkspaceDiscoverResult,
  type WorkspaceBinding,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "../components/ui/dialog";
import { useServerConfigs, useThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentOperateAccess } from "../hooks/useEnvironmentOperateAccess";
import { orchestrationEnvironment } from "../state/orchestration";
import { forkWorkspace } from "../state/forkWorkspace";
import { markPromotedDraftThreadByRef } from "../composerDraftStore";
import { randomUUID } from "../lib/utils";

export function WorkspaceManager({
  environmentId,
  threadId,
  projectId,
  modelSelection,
  runtimeMode,
  interactionMode,
  primaryPath,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  projectId: ProjectId | null;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  primaryPath: string | null;
}) {
  const thread = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const workspace = thread?.workspace;
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.forkMultiRepoVersion === 1;
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const [open, setOpen] = useState(false);
  const [initialConfiguration, setInitialConfiguration] = useState("");
  const [fileEdits, setFileEdits] = useState<Record<string, boolean>>({});
  const onFileDirty = useCallback(
    (id: string, dirty: boolean) =>
      setFileEdits((current) => (current[id] === dirty ? current : { ...current, [id]: dirty })),
    [],
  );
  const [bindings, setBindings] = useState<WorkspaceBindingRequest[]>([]);
  const [folders, setFolders] = useState("");
  const confirmConfigurationDiscard = useUnsavedChangesGuard(
    open &&
      (JSON.stringify(bindings) !== initialConfiguration ||
        folders.trim().length > 0 ||
        Object.values(fileEdits).some(Boolean)),
  );
  const [root, setRoot] = useState("");
  const [discovered, setDiscovered] = useState<WorkspaceDiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [filter, setFilter] = useState("all");
  const inspect = useAtomCommand(forkWorkspace.inspect, { reportFailure: false });
  const discover = useAtomCommand(forkWorkspace.discover, { reportFailure: false });
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Workspace preparation failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const addPaths = (paths: readonly string[]) =>
    void run(async () => {
      const next = [...bindings];
      for (const path of paths) {
        const result = await inspect({ environmentId, input: { path } });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (next.some((entry) => entry.sourcePath === result.value.path)) continue;
        next.push({
          id: randomUUID(),
          label: result.value.path.split(/[\\/]/).at(-1) ?? "Repository",
          sourcePath: result.value.path,
          mode: "current",
        });
      }
      if (next.length > 20) throw new Error("A workspace is limited to 20 repositories.");
      setBindings(next);
      setFolders("");
    });
  const save = () =>
    void run(async () => {
      if (!threadId || !projectId) return;
      if (!thread) {
        const created = await dispatch({
          environmentId,
          input: {
            type: "thread.create",
            commandId: CommandId.make(randomUUID()),
            threadId,
            projectId,
            title: "Multi-repository workspace",
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          },
        });
        if (created._tag === "Failure") throw squashAtomCommandFailure(created);
      }
      const result = await dispatch({
        environmentId,
        input: {
          type: "thread.metadata.update",
          commandId: CommandId.make(randomUUID()),
          threadId,
          workspaceConfiguration: {
            expectedRevision: workspace?.revision ?? 0,
            primaryBindingId: bindings[0]!.id,
            bindings,
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!thread) {
        markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
        void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
      }
    });
  const control = (type: "retry" | "cancel") =>
    void run(async () => {
      if (!workspace || !threadId) return;
      const result = await dispatch({
        environmentId,
        input: {
          type: "thread.metadata.update",
          commandId: CommandId.make(randomUUID()),
          threadId,
          workspaceControl: { type, expectedRevision: workspace.revision },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    });
  if (!supported || !threadId || !projectId || !primaryPath) return null;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setBindings(
            workspace?.bindings.map((binding) => ({
              ...binding,
              branch: binding.branch ?? undefined,
            })) ?? [
              {
                id: "primary",
                label: primaryPath.split(/[\\/]/).at(-1) ?? "Primary repository",
                sourcePath: primaryPath,
                mode: "current",
              },
            ],
          );
          setInitialConfiguration(
            JSON.stringify(
              workspace?.bindings.map((binding) => ({
                ...binding,
                branch: binding.branch ?? undefined,
              })) ?? [
                {
                  id: "primary",
                  label: primaryPath.split(/[\\/]/).at(-1) ?? "Primary repository",
                  sourcePath: primaryPath,
                  mode: "current",
                },
              ],
            ),
          );
          setOpen(true);
        }}
      >
        Repositories {workspace ? `(${workspace.bindings.length} · ${workspace.state})` : ""}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next || confirmConfigurationDiscard()) setOpen(next);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Thread repositories</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {error ? <p role="alert">{error}</p> : null}
            <p>
              Paths refer to this execution host. Each repository keeps its own branch. New
              worktrees start from a commit and do not copy uncommitted or ignored files.
              Full-access providers are not confined by this list.
            </p>
            {workspace ? (
              <>
                <p>
                  Revision {workspace.revision}. Preparation: {workspace.state}. Worktrees remain on
                  cancellation. Automatic cleanup is disabled for this workspace.
                </p>
                <Button
                  type="button"
                  disabled={busy || !canOperate || workspace.state !== "failed"}
                  onClick={() => control("retry")}
                >
                  Retry failed repositories
                </Button>
                <Button
                  type="button"
                  disabled={
                    busy ||
                    !canOperate ||
                    workspace.state === "ready" ||
                    workspace.state === "cancelled"
                  }
                  variant="outline"
                  onClick={() => control("cancel")}
                >
                  Cancel preparation
                </Button>
                <label className="block">
                  View
                  <select
                    value={filter}
                    onChange={(e) => {
                      if (confirmConfigurationDiscard()) setFilter(e.target.value);
                    }}
                  >
                    <option value="all">All repositories</option>
                    {workspace.bindings.map((binding) => (
                      <option key={binding.id} value={binding.id}>
                        {binding.label}
                      </option>
                    ))}
                  </select>
                </label>
                {workspace.bindings
                  .filter((binding) => filter === "all" || binding.id === filter)
                  .map((binding) => (
                    <BindingView
                      key={`${environmentId}:${threadId}:${binding.id}`}
                      environmentId={environmentId}
                      threadId={threadId}
                      workspace={workspace}
                      binding={binding}
                      canOperate={canOperate}
                      onDirtyChange={onFileDirty}
                    />
                  ))}
              </>
            ) : null}
            <fieldset disabled={busy || !canOperate} className="space-y-3">
              <legend>Configure repositories before the first provider session</legend>
              {bindings.map((binding, index) => (
                <div key={binding.id} className="space-y-2">
                  <p>
                    {index === 0 ? "Primary · " : ""}
                    {binding.sourcePath}
                  </p>
                  <label className="block">
                    Label
                    <Input
                      value={binding.label}
                      onChange={(e) =>
                        setBindings((entries) =>
                          entries.map((entry) =>
                            entry.id === binding.id ? { ...entry, label: e.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="block">
                    Checkout mode
                    <select
                      value={binding.mode}
                      onChange={(e) =>
                        setBindings((entries) =>
                          entries.map((entry) =>
                            entry.id === binding.id
                              ? {
                                  ...entry,
                                  mode: e.target.value as WorkspaceBindingRequest["mode"],
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option value="current">Current checkout</option>
                      <option value="existing-worktree">Selected existing worktree</option>
                      <option value="new-worktree">New owned worktree</option>
                    </select>
                  </label>
                  {binding.mode === "new-worktree" ? (
                    <>
                      <label className="block">
                        Base ref
                        <Input
                          value={binding.baseRef ?? ""}
                          onChange={(e) =>
                            setBindings((entries) =>
                              entries.map((entry) =>
                                entry.id === binding.id
                                  ? { ...entry, baseRef: e.target.value }
                                  : entry,
                              ),
                            )
                          }
                        />
                      </label>
                      <label className="block">
                        New branch
                        <Input
                          value={binding.branch ?? ""}
                          onChange={(e) =>
                            setBindings((entries) =>
                              entries.map((entry) =>
                                entry.id === binding.id
                                  ? { ...entry, branch: e.target.value }
                                  : entry,
                              ),
                            )
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  {index > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setBindings((entries) => entries.filter((entry) => entry.id !== binding.id))
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))}
              <label className="block">
                Add explicit repository folders (one per line)
                <Textarea value={folders} onChange={(e) => setFolders(e.target.value)} />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={!folders.trim()}
                onClick={() =>
                  addPaths(
                    folders
                      .split("\n")
                      .map((path) => path.trim())
                      .filter(Boolean),
                  )
                }
              >
                Validate and add folders
              </Button>
              <label className="block">
                Discover under folder
                <Input value={root} onChange={(e) => setRoot(e.target.value)} />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={!root.trim()}
                onClick={() =>
                  void run(async () => {
                    const result = await discover({ environmentId, input: { root, depth: 3 } });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    setDiscovered(result.value);
                  })
                }
              >
                Discover repositories
              </Button>
              {discovered ? (
                <>
                  <p>
                    {discovered.repositories.length} candidates.{" "}
                    {discovered.limited
                      ? "Scan limits reached. Use explicit folder selection for others."
                      : ""}
                  </p>
                  {discovered.issues.map((issue) => (
                    <p key={issue.path}>
                      {issue.path}: {issue.reason}
                    </p>
                  ))}
                  {discovered.repositories.map((repository) => (
                    <div key={repository.path}>
                      <p>
                        {repository.path} · {repository.branch ?? "Detached HEAD"} ·{" "}
                        {repository.dirty ? "Uncommitted changes" : "Clean"}{" "}
                        {repository.operation ?? ""}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => addPaths([repository.path])}
                      >
                        Add this repository
                      </Button>
                    </div>
                  ))}
                </>
              ) : null}
              <Button
                type="button"
                disabled={
                  bindings.length === 0 ||
                  bindings.some(
                    (binding) =>
                      !binding.label.trim() ||
                      (binding.mode === "new-worktree" && (!binding.baseRef || !binding.branch)),
                  )
                }
                onClick={save}
              >
                Prepare workspace
              </Button>
            </fieldset>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
function BindingView({
  environmentId,
  threadId,
  workspace,
  binding,
  canOperate,
  onDirtyChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspace: ThreadWorkspace;
  binding: WorkspaceBinding;
  canOperate: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const target = { threadId, bindingId: binding.id, expectedRevision: workspace.revision };
  const status = useEnvironmentQuery(
    binding.state === "ready" ? forkWorkspace.status({ environmentId, input: target }) : null,
  );
  const [showDiff, setShowDiff] = useState(false);
  const [baseRef, setBaseRef] = useState(binding.baseCommit);
  const diff = useEnvironmentQuery(
    showDiff && binding.state === "ready"
      ? forkWorkspace.diff({ environmentId, input: { ...target, baseRef } })
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const openTerminal = useAtomCommand(forkWorkspace.terminal, { reportFailure: false });
  const readFile = useAtomCommand(forkWorkspace.readFile, { reportFailure: false });
  const [filePath, setFilePath] = useState("");
  const [contents, setContents] = useState<string | null>(null);
  const [openedFile, setOpenedFile] = useState<ProjectReadFileResult | null>(null);
  const [openedRevision, setOpenedRevision] = useState<number | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProjectSearchEntriesResult | null>(null);
  const search = useAtomCommand(forkWorkspace.search, { reportFailure: false });
  const writeFile = useAtomCommand(forkWorkspace.writeFile, { reportFailure: false });
  useEffect(() => {
    onDirtyChange(binding.id, openedFile !== null && contents !== openedFile.contents);
    return () => onDirtyChange(binding.id, false);
  }, [binding.id, openedFile, contents, onDirtyChange]);
  const confirmDiscard = useUnsavedChangesGuard(
    openedFile !== null && contents !== openedFile.contents,
  );
  const openFile = async (relativePath: string) => {
    if (!confirmDiscard()) return;
    const result = await readFile({ environmentId, input: { ...target, relativePath } });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      setOpenedFile(result.value);
      setOpenedRevision(workspace.revision);
      setContents(result.value.contents);
      setFilePath(result.value.relativePath);
    }
  };
  const saveFile = async () => {
    if (!openedFile || contents === null || lock.current) return;
    if (openedRevision !== workspace.revision) {
      setError(
        "The workspace changed while this file was open. Copy your edits and reopen the file before saving.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await writeFile({
        environmentId,
        input: {
          ...target,
          relativePath: openedFile.relativePath,
          expectedContents: openedFile.contents,
          contents,
        },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else {
        setOpenedFile({ ...openedFile, contents });
        status.refresh();
        diff.refresh();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const action = useAtomCommand(forkWorkspace.gitAction, { reportFailure: false });
  const perform = (kind: "commit" | "push" | "create_pr") => {
    if (
      lock.current ||
      !canOperate ||
      !window.confirm(`${kind.replace("_", " ")} only ${binding.label} at ${binding.checkoutPath}?`)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    void action({ environmentId, input: { ...target, actionId: randomUUID(), action: kind } })
      .then((result) => {
        if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
        else status.refresh();
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  };
  return (
    <section className="my-4 space-y-2">
      <h3>{binding.label}</h3>
      <p>
        {binding.checkoutPath} · {binding.branch ?? "Detached HEAD"} · {binding.state}
      </p>
      {binding.error || status.error || error ? (
        <p role="alert">{binding.error ?? status.error ?? error}</p>
      ) : null}
      {status.data ? (
        <>
          <p>{status.data.workingTree.files.length} changed files. External edits are included.</p>
          {status.data.repository.changes?.map((file) => (
            <p key={`${binding.id}:${file.path}`}>
              {binding.label}/{file.path} ·{" "}
              {[
                file.conflicted ? "Conflicted" : null,
                file.staged ? "Staged" : null,
                file.unstaged ? "Unstaged" : null,
                file.untracked ? "Untracked" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ))}
        </>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          status.refresh();
          diff.refresh();
        }}
      >
        Refresh
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={!canOperate || busy || binding.state !== "ready"}
        onClick={() => {
          const terminalId = `repo:${binding.id}:${randomUUID().slice(0, 8)}`;
          void openTerminal({ environmentId, input: { ...target, terminalId } }).then((result) => {
            if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
            else
              useTerminalUiStateStore
                .getState()
                .ensureTerminal(scopeThreadRef(environmentId, threadId), terminalId, {
                  open: true,
                  active: true,
                });
          });
        }}
      >
        Open terminal for {binding.label}
      </Button>
      <label className="block">
        Search files in {binding.label}
        <Input value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} />
      </label>
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          void search({ environmentId, input: { ...target, query: fileQuery } }).then((result) => {
            if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
            else setSearchResults(result.value);
          })
        }
      >
        Search files
      </Button>
      {searchResults?.truncated ? <p>Results truncated. Narrow the search.</p> : null}
      {searchResults?.entries.map((entry) => (
        <Button
          key={`${binding.id}:${entry.path}`}
          type="button"
          variant="ghost"
          onClick={() => void openFile(entry.path)}
        >
          {binding.label}/{entry.path}
        </Button>
      ))}
      <label className="block">
        Open file in {binding.label}
        <Input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
      </label>
      <Button
        type="button"
        disabled={!filePath.trim() || busy}
        variant="outline"
        onClick={() => void openFile(filePath)}
      >
        Open file
      </Button>
      {openedFile && contents !== null ? (
        <>
          <p>
            {binding.label}/{openedFile.relativePath}
            {openedFile.truncated ? " · Truncated; editing unavailable" : ""}
          </p>
          {openedRevision !== workspace.revision ? (
            <p role="alert">
              The workspace changed. Copy your edits and reopen this file before saving.
            </p>
          ) : null}
          <Textarea
            aria-label={`Edit ${binding.label}/${openedFile.relativePath}`}
            value={contents}
            readOnly={!canOperate || openedFile.truncated || openedRevision !== workspace.revision}
            onChange={(event) => setContents(event.target.value)}
          />
          <Button
            type="button"
            disabled={
              !canOperate || busy || openedFile.truncated || contents === openedFile.contents
            }
            onClick={() => void saveFile()}
          >
            Save file in {binding.label}
          </Button>
        </>
      ) : null}

      <label className="block">
        Comparison base
        <Input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
      </label>
      <Button type="button" variant="outline" onClick={() => setShowDiff(!showDiff)}>
        Working and branch diffs
      </Button>
      {showDiff ? (
        <>
          {diff.error ? <p role="alert">{diff.error}</p> : null}
          {diff.data?.sources.map((source) => (
            <div key={`${binding.id}:${source.id}`}>
              <p>
                {binding.label} · {source.title}
                {source.truncated ? " · Truncated" : ""}
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{source.diff}</pre>
            </div>
          ))}
        </>
      ) : null}
      {(["commit", "push", "create_pr"] as const).map((kind) => (
        <Button
          type="button"
          key={kind}
          disabled={!canOperate || busy || binding.state !== "ready"}
          variant="outline"
          onClick={() => perform(kind)}
        >
          {kind.replace("_", " ")}
        </Button>
      ))}
    </section>
  );
}
