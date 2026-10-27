import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";
import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    });
  }),
});

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

/**
 * Where the agent starts, and the checkouts outside it that need a directory grant.
 * Paths are canonical checkout paths the workspace recorded on this host.
 */
export function workspaceDirectories(workspace: ThreadWorkspace) {
  const cwd =
    workspace.root?.checkoutPath ??
    workspace.bindings.find((binding) => binding.id === workspace.primaryBindingId)!.checkoutPath;
  const inside = cwd + (cwd.includes("\\") ? "\\" : "/");
  return {
    cwd,
    additionalDirectories: workspace.bindings
      .map((binding) => binding.checkoutPath)
      .filter((path) => path !== cwd && !path.startsWith(inside)),
  };
}

/**
 * Drivers whose adapters grant `additionalDirectories` to the agent and have
 * been verified against a multi-repository workspace. Others fail closed:
 * starting them would confine the agent to the primary checkout while the
 * thread claims every binding.
 */
const MULTI_REPOSITORY_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["codex", "claudeAgent", "muse"].map((driver) => ProviderDriverKind.make(driver)),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const workspaceRepositories = yield* Effect.serviceOption(
      WorkspaceRepositories.WorkspaceRepositories,
    );
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        let workspacePolicy:
          | {}
          | {
              cwd: string;
              additionalDirectories: readonly string[];
              workspaceInstructions: string;
            } = {};
        if (input.thread.workspace) {
          const workspace = input.thread.workspace;
          const error = (cause: unknown) =>
            new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
              cause,
            });
          if (Option.isNone(workspaceRepositories))
            return yield* error("Workspace validation is unavailable.");
          yield* workspaceRepositories.value.validate(workspace).pipe(Effect.mapError(error));
          const { cwd, additionalDirectories } = workspaceDirectories(workspace);
          if (
            additionalDirectories.length > 0 &&
            !(instance && MULTI_REPOSITORY_DRIVERS.has(instance.driverKind))
          )
            return yield* error(
              "This provider has not been verified for multi-repository access. Select Codex, Claude, or Muse.",
            );
          workspacePolicy = {
            cwd,
            additionalDirectories,
            workspaceInstructions: [
              `Validated workspace revision ${workspace.revision}. The application owns checkout configuration. Do not create, switch, reset, stash, or delete worktrees.`,
              ...(workspace.root
                ? [
                    workspace.root.mode === "mirror"
                      ? `Working folder ${cwd} mirrors ${workspace.root.sourcePath}: each repository below is a worktree at its original relative path. Files outside those repositories were not copied.`
                      : `Working folder ${cwd} holds the repositories below.`,
                  ]
                : []),
              ...workspace.bindings.map(
                (binding) =>
                  `${binding.id}: ${binding.label}; ${binding.mode}; ${binding.checkoutPath}; branch ${binding.branch ?? "detached"}. Apply each repository's instructions only to paths in that repository.`,
              ),
              "Directory grants do not confine a provider running with full access. Preserve the user's approval and access mode. Git metadata outside the checkout requires approval or validated application Git actions.",
            ].join("\n"),
          };
        }
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...workspacePolicy,
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
