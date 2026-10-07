import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { randomUUID } from "../lib/utils";
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProjectId, QuickAction, QuickActionFields } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  exportPortableActions,
  importPortableActions,
  validateQuickActionTemplate,
} from "@t3tools/shared/quickActions";
import { mergeWithDefaultKeybindings, parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useProjects, useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { quickActionsEnvironment } from "../state/quickActions";
import { serverEnvironment } from "../state/server";
import { useEnvironmentOperateAccess } from "../hooks/useEnvironmentOperateAccess";
import {
  buildKeybindingRows,
  shortcutToKeybindingInput,
} from "../components/settings/KeybindingsSettings.logic";

const blankAction = (): QuickActionFields => ({
  id: randomUUID(),
  name: "",
  description: "",
  aliases: [],
  tags: [],
  category: null,
  template: "",
  projectId: null,
  enabled: true,
  favorite: false,
});
export function QuickActionLibrary({
  environmentId,
  onDirtyChange,
}: {
  environmentId: EnvironmentId;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const config = useServerConfigs().get(environmentId);
  const supported = config?.environment.capabilities.forkQuickActionsVersion === 1;
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const list = useEnvironmentQuery(
    supported ? quickActionsEnvironment.list({ environmentId, input: {} }) : null,
  );
  const save = useAtomCommand(quickActionsEnvironment.save, { reportFailure: false });
  const importCopies = useAtomCommand(quickActionsEnvironment.importCopies, {
    reportFailure: false,
  });
  const remove = useAtomCommand(quickActionsEnvironment.remove, { reportFailure: false });
  const upsert = useAtomCommand(serverEnvironment.upsertKeybinding, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [editing, setEditing] = useState<QuickActionFields | null>(null);
  const [original, setOriginal] = useState<QuickAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [preview, setPreview] = useState<QuickActionFields[] | null>(null);
  const [shortcut, setShortcut] = useState("");
  const fields = (patch: Partial<QuickActionFields>) =>
    setEditing((action) => (action ? { ...action, ...patch } : null));
  const dirty =
    editing !== null &&
    (shortcut.trim() !== "" ||
      original === null ||
      Object.keys(editing).some(
        (key) =>
          JSON.stringify(editing[key as keyof QuickActionFields]) !==
          JSON.stringify(original[key as keyof QuickActionFields]),
      ));
  useUnsavedChangesGuard(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const openEditor = (action: QuickAction | null, duplicate = false) => {
    if (dirty && !window.confirm("Discard unsaved action changes?")) return;
    setError(null);
    setOriginal(duplicate ? null : action);
    setEditing(
      action
        ? { ...action, ...(duplicate ? { id: randomUUID(), name: `${action.name} copy` } : {}) }
        : blankAction(),
    );
    setShortcut("");
  };
  const run = async (work: () => Promise<void>) => {
    if (lock.current || !canOperate) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      list.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The action could not be saved.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const persist = () =>
    void run(async () => {
      if (!editing) return;
      const errors = validateQuickActionTemplate(editing.template);
      if (errors.length) throw new Error(errors.join("\n"));
      let normalized: string | null = null;
      if (shortcut.trim()) {
        const parsed = parseKeybindingShortcut(shortcut);
        if (!parsed) throw new Error("Enter a valid shortcut, such as mod+g.");
        normalized = shortcutToKeybindingInput(parsed);
        // Conservatively block every existing accelerator, including conditional bindings.
        const conflict = buildKeybindingRows(
          mergeWithDefaultKeybindings(config?.keybindings ?? []),
          "",
        ).find((row) => row.key === normalized);
        if (conflict)
          throw new Error(
            `This shortcut is used by ${conflict.command}. Change it in Settings → Keybindings first.`,
          );
      }
      const result = await save({
        environmentId,
        input: { action: editing, expectedRevision: original?.revision ?? null },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setOriginal(result.value);
      setEditing(result.value);
      if (normalized) {
        const binding = await upsert({
          environmentId,
          input: {
            command: `quickAction.${editing.id}.insert`,
            key: normalized,
            when: "!terminalFocus && !previewFocus",
          },
        });
        if (binding._tag === "Failure") throw squashAtomCommandFailure(binding);
        setShortcut("");
      }
    });
  if (!supported)
    return (
      <p>
        Quick actions are unavailable on this environment. Connect to a matching J4 Code server.
      </p>
    );
  return (
    <div className="space-y-4">
      <p>
        Actions belong to this environment. Other authorized clients can read them. Keep secrets out
        of templates.
      </p>
      {!canOperate ? <p>Your connection can view and copy actions. It cannot edit them.</p> : null}
      {(error ?? list.error) ? <p role="alert">{error ?? list.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canOperate || busy} onClick={() => openEditor(null)}>
          Create
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canOperate || busy}
          onClick={() => {
            setTransfer("");
            setPreview(null);
          }}
        >
          Import
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            try {
              setTransfer(exportPortableActions(list.data ?? []));
              setPreview(null);
            } catch (failure) {
              setError((failure as Error).message);
            }
          }}
        >
          Export all
        </Button>
        <Button type="button" variant="ghost" onClick={list.refresh}>
          Reload
        </Button>
      </div>
      {(list.data ?? []).map((action) => (
        <div key={action.id} className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={() => openEditor(action)}>
            {action.favorite ? "★ " : ""}
            {action.name}
            {!action.enabled ? " (disabled)" : ""} · {action.projectId ? "Project" : "Environment"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canOperate}
            onClick={() => openEditor(action, true)}
          >
            Duplicate
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              try {
                setTransfer(exportPortableActions([action]));
                setPreview(null);
              } catch (failure) {
                setError((failure as Error).message);
              }
            }}
          >
            Export
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canOperate || busy}
            onClick={() => {
              if (window.confirm(`Delete “${action.name}”? Its shortcut will become unavailable.`))
                void run(async () => {
                  const result = await remove({
                    environmentId,
                    input: { id: action.id, expectedRevision: action.revision },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  if (editing?.id === action.id) {
                    setEditing(null);
                    setOriginal(null);
                  }
                });
            }}
          >
            Delete
          </Button>
        </div>
      ))}
      {editing ? (
        <fieldset disabled={!canOperate || busy} className="space-y-3">
          <legend>{original ? "Edit action" : "New action"}</legend>
          <label className="block">
            Name
            <Input
              maxLength={120}
              value={editing.name}
              onChange={(e) => fields({ name: e.target.value })}
            />
          </label>
          <label className="block">
            Description
            <Input
              maxLength={1024}
              value={editing.description}
              onChange={(e) => fields({ description: e.target.value })}
            />
          </label>
          <label className="block">
            Aliases (comma separated)
            <Input
              value={editing.aliases.join(",")}
              onChange={(e) => fields({ aliases: e.target.value.split(",") })}
            />
          </label>
          <label className="block">
            Tags (comma separated)
            <Input
              value={editing.tags.join(",")}
              onChange={(e) => fields({ tags: e.target.value.split(",") })}
            />
          </label>
          <label className="block">
            Category
            <Input
              value={editing.category ?? ""}
              onChange={(e) => fields({ category: e.target.value || null })}
            />
          </label>
          <label className="block">
            Scope
            <select
              value={editing.projectId ?? ""}
              onChange={(e) =>
                fields({ projectId: e.target.value ? (e.target.value as ProjectId) : null })
              }
            >
              <option value="">All projects on this environment</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Template
            <Textarea
              rows={8}
              value={editing.template}
              onChange={(e) => fields({ template: e.target.value })}
            />
          </label>
          {validateQuickActionTemplate(editing.template).map((message) => (
            <p key={message} role="alert">
              {message}
            </p>
          ))}
          <label className="block">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => fields({ enabled: e.target.checked })}
            />{" "}
            Enabled
          </label>
          <label className="block">
            <input
              type="checkbox"
              checked={editing.favorite}
              onChange={(e) => fields({ favorite: e.target.checked })}
            />{" "}
            Favorite
          </label>
          <label className="block">
            Add direct shortcut
            <Input
              placeholder="mod+g"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
            />
          </label>
          <p>
            Existing bindings stay in Settings → Keybindings. Conflicting keys are blocked.
            Duplicates never copy shortcuts.
          </p>
          <Button
            type="button"
            disabled={
              !editing.name.trim() || validateQuickActionTemplate(editing.template).length > 0
            }
            onClick={persist}
          >
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (!dirty || window.confirm("Discard unsaved action changes?")) {
                setEditing(null);
                setOriginal(null);
              }
            }}
          >
            Close editor
          </Button>
        </fieldset>
      ) : null}
      {transfer !== null ? (
        <div className="space-y-2">
          <label className="block">
            Portable V1 JSON
            <Textarea
              rows={8}
              value={transfer}
              onChange={(e) => {
                setTransfer(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <p>
            Incoming copy, paste, and inherit modes all map to editable insertion. Shortcuts are
            never imported. Matching IDs are copied with new IDs. No existing action is overwritten.
          </p>
          <Button
            type="button"
            disabled={!canOperate || busy}
            onClick={() => {
              try {
                setPreview(importPortableActions(transfer));
                setError(null);
              } catch (failure) {
                setError((failure as Error).message);
              }
            }}
          >
            Preview import
          </Button>
          {preview ? (
            <>
              <p>
                {preview.length} actions.{" "}
                {
                  preview.filter((action) =>
                    list.data?.some((existing) => existing.id === action.id),
                  ).length
                }{" "}
                ID collisions will receive new IDs.
              </p>
              {preview.map((action) => (
                <p key={action.id}>{action.name}</p>
              ))}
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const actions = preview.map((action) =>
                      list.data?.some((existing) => existing.id === action.id)
                        ? { ...action, id: randomUUID() }
                        : action,
                    );
                    const result = await importCopies({ environmentId, input: { actions } });
                    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    setPreview(null);
                    setTransfer(null);
                  })
                }
              >
                Import copies
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setTransfer(null);
              setPreview(null);
            }}
          >
            Close transfer
          </Button>
        </div>
      ) : null}
    </div>
  );
}
