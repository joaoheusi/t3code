import type {
  EnvironmentId,
  ProjectId,
  QuickAction,
  QuickActionFields,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import {
  QUICK_ACTION_VARIABLES,
  exportPortableActions,
  importPortableActions,
  quickActionRequirements,
  rankQuickActions,
  validateQuickActionTemplate,
  type QuickActionVariable,
} from "@t3tools/shared/quickActions";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BracesIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  UploadIcon,
  ZapIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useEnvironmentOperateAccess } from "../../hooks/useEnvironmentOperateAccess";
import { shortcutLabelForCommand } from "../../keybindings";
import { downloadTextFile } from "../../lib/downloadTextFile";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useQuickActionsSupported } from "../../quickActions/useQuickActions";
import {
  NEW_QUICK_ACTION_HASH,
  quickActionCommand,
} from "../../quickActions/useQuickActionPalette";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { quickActionsEnvironment } from "../../state/quickActions";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildKeybindingRows,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
} from "./KeybindingsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const VARIABLE_HELP: Record<QuickActionVariable, string> = {
  date: "Today's date",
  time: "The current time",
  clipboard: "Text on your clipboard",
  "thread.title": "The thread's title",
  "workspace.repositories": "Every repository in the thread",
  "repo.name": "The repository's name",
  "repo.path": "The repository's checkout path",
  "repo.branch": "The repository's current branch",
  "pr.url": "The linked pull request's URL",
  "ci.failures": "Failing checks on the linked pull request",
  "pr.conflicts": "Conflict state of the linked pull request",
};
// Shortcuts fire from anywhere but a focused terminal or preview, like other composer actions.
const SHORTCUT_WHEN = "!terminalFocus && !previewFocus";

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** One-line summary of the context an action needs before it can insert. */
function contextSummary(template: string): string | null {
  const needs = quickActionRequirements(template);
  if (needs.pullRequest) return "Needs a linked pull request";
  if (needs.repository) return "Uses repository details";
  if (needs.thread) return "Uses the thread title";
  if (needs.clipboard) return "Uses your clipboard";
  return null;
}

/** Labelled field: a caption sitting above its control. */
function Field(props: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={props.htmlFor}>
        <span>{props.label}</span>
        {props.hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{props.hint}</span>
        ) : null}
      </Label>
      {props.children}
    </div>
  );
}

export function QuickActionsSettingsPanel() {
  const { environment } = useSettingsScope();
  if (!environment) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Quick actions">
          <SettingsRow
            title="Choose a machine"
            description="Quick actions belong to one machine. Pick it in the sentence above."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <QuickActionsEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      keybindings={environment.serverConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS}
    />
  );
}

type EditorRequest = { readonly action: QuickAction | null; readonly duplicateOf?: QuickAction };

function QuickActionsEnvironmentSettings(props: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const { environmentId, keybindings } = props;
  const { scope } = useSettingsScope();
  const supported = useQuickActionsSupported(environmentId);
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const list = useEnvironmentQuery(
    supported ? quickActionsEnvironment.list({ environmentId, input: {} }) : null,
  );
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const scopedProjectIds = useMemo(
    () =>
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(
            scope.members
              .filter((member) => member.environmentId === environmentId)
              .map((member) => member.id),
          )
        : null,
    [environmentId, scope],
  );
  const actions = useMemo(
    () =>
      (list.data ?? []).filter(
        (action) =>
          scopedProjectIds === null ||
          action.projectId === null ||
          scopedProjectIds.has(action.projectId),
      ),
    [list.data, scopedProjectIds],
  );
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  const [importing, setImporting] = useState(false);

  // "New quick action" from the command palette lands here with a hash.
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  useEffect(() => {
    if (hash !== NEW_QUICK_ACTION_HASH || !canOperate || !supported) return;
    setEditor({ action: null });
    void navigate({ hash: "", replace: true, resetScroll: false, hashScrollIntoView: false });
  }, [canOperate, hash, navigate, supported]);

  const exportActions = (selected: readonly QuickAction[]) => {
    const portable = selected.filter((action) => !quickActionRequirements(action.template).host);
    const skipped = selected.length - portable.length;
    if (portable.length === 0) {
      toastManager.add({
        type: "info",
        title: "Nothing to export",
        description: "Thread, repository, and pull request variables only work in this app.",
      });
      return;
    }
    try {
      downloadTextFile(
        portable.length === 1 ? `${slug(portable[0]!.name)}.json` : "quick-actions.json",
        exportPortableActions(portable, new Date().toISOString()),
      );
    } catch (error) {
      reportFailure("Could not export quick actions", error);
      return;
    }
    if (skipped > 0)
      toastManager.add({
        type: "info",
        title: `Exported ${portable.length} of ${selected.length} actions`,
        description: `${skipped} use thread, repository, or pull request variables, which only work in this app.`,
      });
  };

  const categories = useMemo(() => {
    const groups = new Map<string, QuickAction[]>();
    for (const action of rankQuickActions(actions, "").concat(
      actions.filter((action) => !action.enabled),
    )) {
      const key = action.category?.trim() || "Other";
      groups.set(key, [...(groups.get(key) ?? []), action]);
    }
    return [...groups.entries()].toSorted(([left], [right]) =>
      left === "Other" ? 1 : right === "Other" ? -1 : left.localeCompare(right),
    );
  }, [actions]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Quick actions"
        variant="plain"
        headerAction={
          supported ? (
            <div className="flex items-center gap-1">
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="icon-xs" variant="ghost-muted" aria-label="Import or export" />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={!canOperate} onClick={() => setImporting(true)}>
                    <UploadIcon />
                    Import…
                  </MenuItem>
                  <MenuItem disabled={actions.length === 0} onClick={() => exportActions(actions)}>
                    <DownloadIcon />
                    Export all
                  </MenuItem>
                </MenuPopup>
              </Menu>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canOperate}
                onClick={() => setEditor({ action: null })}
              >
                <PlusIcon className="size-3" />
                New action
              </Button>
            </div>
          ) : null
        }
      >
        <div className="space-y-8">
          {!supported ? (
            <SettingsSection title="Unavailable">
              <SettingsRow
                title="This machine doesn't support quick actions"
                description="Connect to a server running the same J4 Code build to use them."
              />
            </SettingsSection>
          ) : (
            <>
              {!canOperate ? (
                <Alert variant="info">
                  <AlertDescription>
                    This connection can read quick actions but can't change them.
                  </AlertDescription>
                </Alert>
              ) : null}
              <SettingsSection title="Using quick actions">
                <SettingsRow
                  title="Insert into the composer"
                  description="Type / in the composer, or open the list from anywhere in a thread. Text is inserted for you to review; nothing is sent."
                  control={
                    <span className="text-xs text-muted-foreground">
                      {shortcutLabelForCommand(keybindings, "quickActions.toggle") ?? "No shortcut"}
                    </span>
                  }
                />
              </SettingsSection>
              {list.error ? (
                <SettingsSection title="Library">
                  <SettingsRow title="Could not load quick actions" description={list.error} />
                </SettingsSection>
              ) : !list.data ? (
                <SettingsSection title="Library">
                  <SettingsRow title="Loading quick actions…" role="status" />
                </SettingsSection>
              ) : actions.length === 0 ? (
                <SettingsSection title="Library">
                  <SettingsRow
                    title="No quick actions"
                    description="Save instructions you repeat, like how to fix CI or review a change."
                  />
                </SettingsSection>
              ) : (
                categories.map(([category, entries]) => (
                  <SettingsSection key={category} title={category}>
                    {entries.map((action) => (
                      <QuickActionRow
                        key={action.id}
                        environmentId={environmentId}
                        action={action}
                        projectTitle={
                          projects.find((project) => project.id === action.projectId)?.title ?? null
                        }
                        shortcutLabel={shortcutLabelForCommand(
                          keybindings,
                          quickActionCommand(action.id),
                        )}
                        canOperate={canOperate}
                        onEdit={() => setEditor({ action })}
                        onDuplicate={() => setEditor({ action: null, duplicateOf: action })}
                        onExport={() => exportActions([action])}
                        onChanged={list.refresh}
                      />
                    ))}
                  </SettingsSection>
                ))
              )}
            </>
          )}
        </div>
      </SettingsSection>
      {editor ? (
        <QuickActionEditorDialog
          environmentId={environmentId}
          request={editor}
          keybindings={keybindings}
          projects={projects}
          defaultProjectId={
            scopedProjectIds && scopedProjectIds.size === 1 ? [...scopedProjectIds][0]! : null
          }
          onSaved={list.refresh}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {importing ? (
        <QuickActionImportDialog
          environmentId={environmentId}
          existingIds={new Set((list.data ?? []).map((action) => action.id))}
          onImported={list.refresh}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function QuickActionRow(props: {
  environmentId: EnvironmentId;
  action: QuickAction;
  projectTitle: string | null;
  shortcutLabel: string | null;
  canOperate: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onChanged: () => void;
}) {
  const { action, environmentId } = props;
  const [busy, setBusy] = useState(false);
  const save = useAtomCommand(quickActionsEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(quickActionsEnvironment.remove, { reportFailure: false });
  const update = async (patch: Partial<QuickActionFields>) => {
    if (busy) return;
    setBusy(true);
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = action;
    const result = await save({
      environmentId,
      input: { action: { ...fields, ...patch }, expectedRevision: action.revision },
    });
    setBusy(false);
    if (result._tag === "Failure")
      reportFailure("Could not update the action", squashAtomCommandFailure(result));
    else props.onChanged();
  };
  const destroy = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete “${action.name}”? Its shortcut stops working.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({
      environmentId,
      input: { id: action.id, expectedRevision: action.revision },
    });
    setBusy(false);
    if (result._tag === "Failure")
      reportFailure("Could not delete the action", squashAtomCommandFailure(result));
    else props.onChanged();
  };
  const context = contextSummary(action.template);
  return (
    <SettingsRow
      className="group"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{action.name}</span>
          {action.favorite ? (
            <StarIcon aria-label="Favorite" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
        </span>
      }
      description={<span className="line-clamp-2">{action.description || action.template}</span>}
      status={
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{props.projectTitle ?? "All projects"}</Badge>
          {context ? <Badge variant="outline">{context}</Badge> : null}
          {props.shortcutLabel ? <Badge variant="outline">{props.shortcutLabel}</Badge> : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={action.enabled}
            disabled={busy || !props.canOperate}
            aria-label={`Enable ${action.name}`}
            onCheckedChange={(enabled) => void update({ enabled: Boolean(enabled) })}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${action.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!props.canOperate} onClick={props.onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem disabled={!props.canOperate} onClick={props.onDuplicate}>
                <CopyIcon />
                Duplicate
              </MenuItem>
              <MenuItem
                disabled={!props.canOperate}
                onClick={() => void update({ favorite: !action.favorite })}
              >
                {action.favorite ? <StarOffIcon /> : <StarIcon />}
                {action.favorite ? "Remove from favorites" : "Add to favorites"}
              </MenuItem>
              <MenuItem onClick={props.onExport}>
                <DownloadIcon />
                Export
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={!props.canOperate}
                onClick={() => void destroy()}
              >
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

const splitList = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "quick-action";

function QuickActionEditorDialog(props: {
  environmentId: EnvironmentId;
  request: EditorRequest;
  keybindings: ResolvedKeybindingsConfig;
  projects: ReadonlyArray<{ id: ProjectId; title: string }>;
  defaultProjectId: ProjectId | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { environmentId, request, keybindings } = props;
  const editing = request.action;
  const source = editing ?? request.duplicateOf ?? null;
  const formId = useId();
  const templateRef = useRef<HTMLTextAreaElement>(null);
  // The form keeps its own state once open.
  const [initial] = useState(() => ({
    name: request.duplicateOf ? `${request.duplicateOf.name} copy` : (source?.name ?? ""),
    description: source?.description ?? "",
    template: source?.template ?? "",
    category: source?.category ?? "",
    aliases: source?.aliases.join(", ") ?? "",
    tags: source?.tags.join(", ") ?? "",
    projectId: source ? source.projectId : props.defaultProjectId,
    favorite: source?.favorite ?? false,
    enabled: source?.enabled ?? true,
    // A duplicate never copies the original's shortcut.
    shortcut: editing
      ? (keybindingValueForCommand(keybindings, quickActionCommand(editing.id)) ?? "")
      : "",
  }));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const save = useAtomCommand(quickActionsEnvironment.save, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const templateErrors = validateQuickActionTemplate(draft.template);
  const actionId = editing?.id ?? null;
  const ownCommand = actionId ? quickActionCommand(actionId) : null;
  const shortcutConflicts = draft.shortcut
    ? keybindingConflictLabels(
        buildKeybindingRows(mergeWithDefaultKeybindings(keybindings), "").filter(
          (row) => row.command !== ownCommand,
        ),
        { rowId: "", key: draft.shortcut, when: SHORTCUT_WHEN },
      )
    : [];

  const close = async () => {
    if (saving) return;
    if (
      dirty &&
      !(await ensureLocalApi().dialogs.confirm("Discard your changes to this quick action?", {
        variant: "destructive",
      }))
    )
      return;
    props.onClose();
  };

  const captureShortcut = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      set({ shortcut: "" });
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (next) set({ shortcut: next });
  };

  const insertVariable = (name: QuickActionVariable) => {
    const element = templateRef.current;
    const token = `{{${name}}}`;
    const start = element?.selectionStart ?? draft.template.length;
    const end = element?.selectionEnd ?? draft.template.length;
    set({ template: draft.template.slice(0, start) + token + draft.template.slice(end) });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = async () => {
    if (saving) return;
    if (!draft.name.trim() || !draft.template.trim()) {
      reportFailure("The action is incomplete", "Add a name and the text to insert.");
      return;
    }
    if (templateErrors.length > 0) {
      reportFailure("The text has an unknown variable", templateErrors.join("\n"));
      return;
    }
    setSaving(true);
    const id = actionId ?? randomUUID();
    const fields: QuickActionFields = {
      id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      template: draft.template.replace(/\r\n?/g, "\n"),
      category: draft.category.trim() || null,
      aliases: splitList(draft.aliases),
      tags: splitList(draft.tags),
      projectId: draft.projectId,
      favorite: draft.favorite,
      enabled: draft.enabled,
    };
    const saved = await save({
      environmentId,
      input: { action: fields, expectedRevision: editing?.revision ?? null },
    });
    if (saved._tag === "Failure") {
      setSaving(false);
      reportFailure("Could not save the action", squashAtomCommandFailure(saved));
      return;
    }
    props.onSaved();
    if (draft.shortcut !== initial.shortcut) {
      const command = quickActionCommand(id);
      try {
        const previous = initial.shortcut
          ? decodeProjectScriptKeybindingRule({ keybinding: initial.shortcut, command })
          : null;
        const next = draft.shortcut
          ? decodeProjectScriptKeybindingRule({ keybinding: draft.shortcut, command })
          : null;
        const binding = next
          ? await upsertKeybinding({
              environmentId,
              input: {
                ...next,
                when: SHORTCUT_WHEN,
                ...(previous ? { replace: { ...previous, when: SHORTCUT_WHEN } } : {}),
              },
            })
          : previous
            ? await removeKeybinding({ environmentId, input: { ...previous, when: SHORTCUT_WHEN } })
            : null;
        if (binding?._tag === "Failure") throw squashAtomCommandFailure(binding);
      } catch (error) {
        setSaving(false);
        reportFailure("The action was saved, but its shortcut wasn't", error);
        return;
      }
    }
    props.onClose();
  };

  const context = contextSummary(draft.template);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit quick action" : "New quick action"}</DialogTitle>
          <DialogDescription>
            Text you can insert into any thread's composer on this machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void submit();
              }
            }}
          >
            <fieldset disabled={saving} className="space-y-5">
              <Field label="Name" htmlFor={`${formId}-name`}>
                <Input
                  id={`${formId}-name`}
                  autoFocus
                  maxLength={120}
                  placeholder="e.g. Resolve CI"
                  value={draft.name}
                  onChange={(event) => set({ name: event.target.value })}
                />
              </Field>
              <Field
                label="Description"
                hint="Shown next to the name"
                htmlFor={`${formId}-description`}
              >
                <Input
                  id={`${formId}-description`}
                  maxLength={1024}
                  value={draft.description}
                  onChange={(event) => set({ description: event.target.value })}
                />
              </Field>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`${formId}-template`}>Text to insert</Label>
                  <Menu>
                    <MenuTrigger render={<Button type="button" size="xs" variant="ghost-muted" />}>
                      <BracesIcon className="size-3" />
                      Insert variable
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {QUICK_ACTION_VARIABLES.map((name) => (
                        <MenuItem key={name} onClick={() => insertVariable(name)}>
                          <span className="font-mono text-xs">{`{{${name}}}`}</span>
                          <span className="ms-auto ps-4 text-muted-foreground text-xs">
                            {VARIABLE_HELP[name]}
                          </span>
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                </div>
                <Textarea
                  ref={templateRef}
                  id={`${formId}-template`}
                  placeholder="What should the agent do?"
                  value={draft.template}
                  aria-invalid={templateErrors.length > 0 || undefined}
                  onChange={(event) => set({ template: event.target.value })}
                />
                {templateErrors.length > 0 ? (
                  templateErrors.map((error) => (
                    <p key={error} className="text-xs text-destructive">
                      {error}
                    </p>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {context ? `${context}. ` : ""}Write \{"{{"} to type literal braces.
                  </p>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Available in" htmlFor={`${formId}-scope`}>
                  <Select
                    value={draft.projectId ?? ""}
                    onValueChange={(value) =>
                      set({ projectId: value ? (value as ProjectId) : null })
                    }
                  >
                    <SelectTrigger id={`${formId}-scope`} size="sm">
                      <SelectValue>
                        {props.projects.find((project) => project.id === draft.projectId)?.title ??
                          "All projects"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">All projects</SelectItem>
                      {props.projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <Field label="Category" htmlFor={`${formId}-category`}>
                  <Input
                    id={`${formId}-category`}
                    size="sm"
                    maxLength={120}
                    placeholder="e.g. Pull requests"
                    value={draft.category}
                    onChange={(event) => set({ category: event.target.value })}
                  />
                </Field>
                <Field label="Other names" hint="Comma separated" htmlFor={`${formId}-aliases`}>
                  <Input
                    id={`${formId}-aliases`}
                    size="sm"
                    placeholder="fix ci, checks"
                    value={draft.aliases}
                    onChange={(event) => set({ aliases: event.target.value })}
                  />
                </Field>
                <Field label="Tags" hint="Comma separated" htmlFor={`${formId}-tags`}>
                  <Input
                    id={`${formId}-tags`}
                    size="sm"
                    value={draft.tags}
                    onChange={(event) => set({ tags: event.target.value })}
                  />
                </Field>
              </div>
              <Field label="Shortcut" htmlFor={`${formId}-shortcut`}>
                <Input
                  id={`${formId}-shortcut`}
                  size="sm"
                  font="mono"
                  readOnly
                  data-keybinding-capture=""
                  placeholder="Press a shortcut"
                  value={draft.shortcut}
                  onKeyDown={captureShortcut}
                />
                <p
                  className={
                    shortcutConflicts.length > 0
                      ? "text-xs text-warning"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {shortcutConflicts.length > 0
                    ? `Also used by ${shortcutConflicts.slice(0, 3).join(", ")}. The latest binding wins.`
                    : "Inserts this action directly. Backspace clears it."}
                </p>
              </Field>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                <span>Show first in lists</span>
                <Switch
                  checked={draft.favorite}
                  onCheckedChange={(checked) => set({ favorite: Boolean(checked) })}
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                <span>Enabled</span>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(checked) => set({ enabled: Boolean(checked) })}
                />
              </label>
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => void close()}>
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create action"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function QuickActionImportDialog(props: {
  environmentId: EnvironmentId;
  existingIds: ReadonlySet<string>;
  onImported: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importCopies = useAtomCommand(quickActionsEnvironment.importCopies, {
    reportFailure: false,
  });
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { actions: importPortableActions(text), error: null };
    } catch (error) {
      return {
        actions: [],
        error: error instanceof SyntaxError ? "This isn't valid JSON." : (error as Error).message,
      };
    }
  }, [text]);
  const collisions =
    parsed?.actions.filter((action) => props.existingIds.has(action.id)).length ?? 0;

  const submit = async () => {
    if (!parsed || parsed.actions.length === 0 || saving) return;
    setSaving(true);
    // Imports are copies: a matching ID gets a new one, so nothing existing is overwritten.
    const actions = parsed.actions.map((action) =>
      props.existingIds.has(action.id) ? { ...action, id: randomUUID() } : action,
    );
    const result = await importCopies({ environmentId: props.environmentId, input: { actions } });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure("Could not import quick actions", squashAtomCommandFailure(result));
      return;
    }
    toastManager.add({
      type: "success",
      title: `Imported ${actions.length} quick action${actions.length === 1 ? "" : "s"}`,
    });
    props.onImported();
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import quick actions</DialogTitle>
          <DialogDescription>
            Use a file exported from Quick Actions or this app. Imports are added as copies, without
            shortcuts.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon className="size-3.5" />
                Choose file…
              </Button>
              <span className="text-xs text-muted-foreground">or paste the JSON below</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    reportFailure("That file is too large", "Imports are limited to 2 MiB.");
                    return;
                  }
                  void file.text().then(setText);
                }}
              />
            </div>
            <Textarea
              aria-label="Quick actions JSON"
              placeholder={'{ "schemaVersion": 1, "actions": [...] }'}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {parsed?.error ? (
              <Alert variant="error">
                <AlertDescription>{parsed.error}</AlertDescription>
              </Alert>
            ) : parsed && parsed.actions.length > 0 ? (
              <div className="space-y-1.5 text-sm">
                <p className="text-muted-foreground text-xs">
                  {parsed.actions.length} action{parsed.actions.length === 1 ? "" : "s"}
                  {collisions > 0 ? ` · ${collisions} already here, imported as copies` : ""}
                </p>
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {parsed.actions.map((action) => (
                    <li key={action.id} className="flex items-center gap-2">
                      <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{action.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || !parsed || parsed.actions.length === 0}
            onClick={() => void submit()}
          >
            {saving
              ? "Importing…"
              : parsed && parsed.actions.length > 0
                ? `Import ${parsed.actions.length}`
                : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
