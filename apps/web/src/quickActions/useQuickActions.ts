import type { ActionContextInput, EnvironmentId, ProjectId, QuickAction } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { quickActionRequirements } from "@t3tools/shared/quickActions";
import { useCallback } from "react";

import type { ComposerThreadTarget } from "../composerDraftStore";
import { toastManager } from "../components/ui/toast";
import { useServerConfigs } from "../state/entities";
import { forkWorkspace } from "../state/forkWorkspace";
import { useEnvironmentQuery } from "../state/query";
import { quickActionsEnvironment } from "../state/quickActions";
import { useAtomCommand } from "../state/use-atom-command";
import { openCommandPalette } from "../commandPaletteBus";
import { actionDispatcher, actionTargetKey, type ActionInvocation } from "./dispatcher";
import {
  captureQuickActionInvocation,
  insertQuickActionText,
  quickActionTargets,
  renderQuickActionText,
  type QuickActionChoice,
  type QuickActionScope,
} from "./quickActionRunner";

const EMPTY: readonly QuickAction[] = [];

export function useQuickActionsSupported(environmentId: EnvironmentId | null) {
  const config = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  return config?.environment.capabilities.forkQuickActionsVersion === 1;
}

/** The environment's library for one project. Subscribe only while a surface shows it. */
export function useQuickActionLibrary(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  active: boolean,
) {
  const supported = useQuickActionsSupported(environmentId);
  const list = useEnvironmentQuery(
    active && supported && environmentId
      ? quickActionsEnvironment.list({ environmentId, input: projectId ? { projectId } : {} })
      : null,
  );
  return {
    supported,
    actions: list.data ?? EMPTY,
    isPending: list.isPending,
    error: list.error,
  };
}

/** Context reads stay on the action's own environment; failures surface as thrown errors. */
export function useResolveActionContext() {
  const resolve = useAtomCommand(forkWorkspace.context, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, input: ActionContextInput) => {
      const result = await resolve({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    [resolve],
  );
}

/**
 * Runs actions against a composer that is not the one handling the keypress:
 * the command palette, a direct shortcut, or a PR button.
 */
export function useRunQuickAction() {
  const reload = useAtomCommand(quickActionsEnvironment.reload, { reportFailure: false });
  const resolveContext = useResolveActionContext();

  // The server owns the template, so every run reads the current, enabled version.
  const loadAction = useCallback(
    async (scope: QuickActionScope, actionId: string) => {
      const library = await reload({
        environmentId: scope.environmentId,
        input: scope.projectId ? { projectId: scope.projectId } : {},
      });
      if (library._tag === "Failure") throw squashAtomCommandFailure(library);
      const action = library.value.find((entry) => entry.id === actionId && entry.enabled);
      if (!action) throw new Error("This action was deleted or disabled.");
      return action;
    },
    [reload],
  );

  const execute = useCallback(
    async (input: {
      readonly name: string;
      readonly actionId: string;
      readonly scope: QuickActionScope;
      readonly target: ComposerThreadTarget;
      readonly invocation: ActionInvocation | null;
      readonly choose: (action: QuickAction) => QuickActionChoice | "deferred";
      readonly showProgress: boolean;
    }) => {
      // Only environment reads are slow enough to need a progress toast.
      const loading = input.showProgress
        ? toastManager.add({ type: "loading", title: `Preparing ${input.name}…` })
        : null;
      try {
        const action = await loadAction(input.scope, input.actionId);
        const choice = input.choose(action);
        if (choice === "deferred") {
          if (input.invocation) actionDispatcher.cancel(input.invocation);
          if (loading) toastManager.close(loading);
          return;
        }
        const rendered = await renderQuickActionText({
          action,
          scope: input.scope,
          choice,
          resolveContext,
        });
        if (loading) toastManager.close(loading);
        insertQuickActionText({
          target: input.target,
          invocation: input.invocation,
          action,
          rendered,
          environmentId: input.scope.environmentId,
          projectId: input.scope.projectId,
        });
      } catch (error) {
        if (input.invocation) actionDispatcher.cancel(input.invocation);
        const failure = {
          type: "error" as const,
          title: `Could not prepare ${input.name}`,
          description: error instanceof Error ? error.message : "Try again.",
        };
        if (loading) toastManager.update(loading, failure);
        else toastManager.add(failure);
      }
    },
    [loadAction, resolveContext],
  );

  /** Runs a chosen action and target, as the palette does. */
  const run = useCallback(
    (input: {
      readonly action: QuickAction;
      readonly choice: QuickActionChoice;
      readonly scope: QuickActionScope;
      readonly target: ComposerThreadTarget;
    }) =>
      execute({
        name: input.action.name,
        actionId: input.action.id,
        scope: input.scope,
        target: input.target,
        // Capture before any await so a later focus change cannot redirect the text.
        invocation: captureQuickActionInvocation(input.target, input.action),
        choose: () => input.choice,
        showProgress: quickActionRequirements(input.action.template).host,
      }),
    [execute],
  );

  /** A direct shortcut runs its action when one target fits and otherwise asks in the palette. */
  const runShortcut = useCallback(
    (input: {
      readonly actionId: string;
      readonly scope: QuickActionScope;
      readonly target: ComposerThreadTarget;
    }) =>
      execute({
        name: "quick action",
        actionId: input.actionId,
        scope: input.scope,
        target: input.target,
        invocation: actionDispatcher.capture(actionTargetKey(input.target), input.actionId, 0),
        choose: (action) => {
          const targets = quickActionTargets(action, input.scope);
          if (targets.kind === "unavailable") throw new Error(`${action.name}: ${targets.reason}.`);
          const [only, ...others] = targets.variants;
          if (only && others.length === 0) return only.choice;
          openCommandPalette({ open: "quick-actions", actionId: action.id });
          return "deferred";
        },
        showProgress: false,
      }),
    [execute],
  );

  return { run, runShortcut };
}
