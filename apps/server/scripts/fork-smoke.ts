// @effect-diagnostics nodeBuiltinImport:off - an isolated end-to-end executable fixture owns its process and temporary files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  WsRpcGroup,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import type { WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
const { spawn, execFileSync } = NodeChildProcess;
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join, resolve } = NodePath;
const { randomBytes } = NodeCrypto;
const assert: typeof NodeAssert.default = NodeAssert.default;
const { createServer } = NodeNet;
const once = NodeEvents.EventEmitter.once;
const request = async (
  url: string,
  options?: { method: "POST"; headers?: Record<string, string>; body?: string },
) => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      let input = options ? HttpClientRequest.post(url) : HttpClientRequest.get(url);
      if (options?.headers) input = HttpClientRequest.setHeaders(input, options.headers);
      if (options?.body)
        input = HttpClientRequest.bodyText(input, options.body, "application/json");
      const response = yield* http.execute(input);
      const body = yield* response.text;
      return { status: response.status, headers: response.headers, body };
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  return {
    status: result.status,
    headers: { get: (name: string) => result.headers[name] ?? null },
    json: async () => JSON.parse(result.body) as unknown,
    text: async () => result.body,
  };
};
const root = realpathSync(mkdtempSync(join(tmpdir(), "j4-fork-smoke-")));
let token = "";
let cookie = "";
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const address = listener.address();
assert(address && typeof address !== "string");
const port = address.port;
listener.close();
await once(listener, "close");
const origin = `http://127.0.0.1:${port}`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const init = (name: string) => {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "user.name", "J4 smoke fixture");
  writeFileSync(join(cwd, "shared.txt"), name + "\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "Initial fixture");
  return cwd;
};
const api = init("api");
const web = init("web");
const home = join(root, "home");
let child: ReturnType<typeof spawn> | null = null;
const start = async () => {
  token = randomBytes(32).toString("hex");
  child = spawn(
    process.execPath,
    [
      resolve("apps/server/dist/bin.mjs"),
      "serve",
      "--base-dir",
      home,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-browser",
      "--bootstrap-fd",
      "3",
    ],
    {
      cwd: root,
      env: { ...process.env, T3CODE_DEV_AUTH_TOKEN: token, T3CODE_DISABLE_AUTO_UPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  (child.stdio[3] as import("node:stream").Writable).end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: token,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }) + "\n",
  );
  const owned = child;
  await Effect.runPromise(
    Effect.callback<void>((resume) => {
      let output = "";
      const onData = (chunk: unknown) => {
        output += String(chunk);
        if (output.includes(`Listening on ${origin}`)) resume(Effect.void);
      };
      const onExit = () => resume(Effect.die(new Error("Isolated server exited during startup")));
      owned.stdout!.on("data", onData);
      owned.on("exit", onExit);
      return Effect.sync(() => {
        owned.stdout!.off("data", onData);
        owned.off("exit", onExit);
      });
    }).pipe(Effect.timeout("30 seconds")),
  );
  const session = await request(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: token }),
  });
  assert.equal(session.status, 200, "Isolated desktop bootstrap must create a browser session");
  cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert(cookie);
};
const stop = async () => {
  if (!child) return;
  const owned = child;
  child = null;
  if (owned.exitCode === null) {
    const exited = once(owned, "exit");
    owned.kill("SIGTERM");
    await exited;
  }
};
const client = async <A, E>(work: (rpc: WsRpcProtocolClient) => Effect.Effect<A, E>) => {
  const response = await request(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(
    response.status,
    200,
    "Scoped browser cookie must authenticate this isolated fixture",
  );
  const body = (await response.json()) as { ticket: string };
  assert(body.ticket);
  const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(
          `${origin.replace("http:", "ws:")}/ws?wsTicket=${encodeURIComponent(body.ticket)}&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
        ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* RpcClient.make(WsRpcGroup);
        return yield* work(rpc);
      }).pipe(Effect.provide(protocol)),
    ),
  );
};
const liveClaude = process.argv.includes("--live-claude");
let nativeResume: string | null = null;
const liveTurn = async (round: "first" | "resumed") =>
  client((rpc) =>
    Effect.gen(function* () {
      const config = yield* rpc[WS_METHODS.serverGetConfig]({});
      const provider = config.providers.find((entry) => entry.driver === "claudeAgent");
      assert(provider, "Claude provider registry entry is required for the optional live test.");
      const model =
        provider.models.find((entry) => entry.isDefault)?.slug ??
        provider.models[0]?.slug ??
        "sonnet";
      const before = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
      const paths = before.thread.workspace!.bindings.map((binding) =>
        join(binding.checkoutPath, "live-round.txt"),
      );
      if (round === "first")
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.runtime-mode.set",
          threadId,
          commandId: commandId(),
          runtimeMode: "full-access",
        });
      const messageId = MessageId.make(`live-${round}`);
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: commandId(),
        threadId,
        messageId,
        text: `This is an isolated verification fixture. Write exactly ${`the word ${round} followed by one newline`} to each of these two files: ${paths.join("; ")}. Only touch those two files. Do not change Git state, inspect other folders, or use the network. Then reply done.`,
        attachments: [],
        modelSelection: { instanceId: provider.instanceId, model },
        dispatchMode: { type: "start_immediately" },
      });
      const reached = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.filter((item) =>
          item.kind === "snapshot"
            ? item.projection.runs.some(
                (run) =>
                  run.userMessageId === messageId &&
                  ["completed", "failed", "waiting", "cancelled"].includes(run.status),
              )
            : item.kind === "event" &&
              item.event.type === "run.updated" &&
              item.event.payload.userMessageId === messageId &&
              ["completed", "failed", "waiting", "cancelled"].includes(item.event.payload.status),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("2 minutes"),
      );
      assert.equal(reached.length, 1);
      const after = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
      const run = after.runs.find((entry) => entry.userMessageId === messageId);
      assert.equal(
        run?.status,
        "completed",
        `The live provider must finish without a pending approval or runtime failure. ${after.turnItems
          .filter((item) => item.type === "error")
          .map((item) => item.failure.message)
          .join("; ")
          .slice(0, 1500)}`,
      );
      for (const path of paths) assert.equal(NodeFS.readFileSync(path, "utf8"), round + "\n");
      const identity =
        after.providerThreads.find((entry) => entry.providerInstanceId === provider.instanceId)
          ?.nativeThreadRef?.nativeId ?? null;
      assert(identity, "The native resume identity must be persisted.");
      if (round === "first") nativeResume = identity;
      else assert.equal(identity, nativeResume, "Restart must resume the same native session.");
    }),
  );
const projectId = ProjectId.make("smoke-project");
const threadId = ThreadId.make("smoke-thread");
let sequence = 0;
const commandId = () => CommandId.make(`smoke-${++sequence}`);
try {
  await start();
  const unauth = await request(`${origin}/api/auth/websocket-ticket`, { method: "POST" });
  assert.equal(unauth.status, 401);
  const descriptor = (await (await request(`${origin}/.well-known/t3/environment`)).json()) as {
    environmentId: string;
    orchestrationProtocolVersion: number;
  };
  assert.equal(descriptor.orchestrationProtocolVersion, 1002);
  const identity = descriptor.environmentId;
  const html = await (await request(origin)).text();
  assert(html.includes("/assets/"), "Server must serve the bundled fork frontend");
  const action = {
    id: "1ab657e0-a3dd-4fb0-9808-c5f2c336b3e1",
    name: "Smoke action",
    description: "",
    aliases: [],
    tags: [],
    category: null,
    template: "{{date}}",
    projectId: null,
    enabled: true,
    favorite: false,
  };
  await client((rpc) =>
    Effect.gen(function* () {
      const config = yield* rpc[WS_METHODS.serverGetConfig]({});
      assert.equal(config.environment.capabilities.forkMultiRepoVersion, 1);
      yield* rpc[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: commandId(),
        projectId,
        title: "API fixture",
        workspaceRoot: api,
      });
      const provider = config.providers.find((entry) => entry.driver === "codex");
      assert(provider, "Codex registry entry required; no provider turn is started");
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.create",
        commandId: commandId(),
        threadId,
        projectId,
        title: "Two repositories",
        modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* rpc[WS_METHODS.quickActionsSave]({ action, expectedRevision: null });
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.metadata.update",
        commandId: commandId(),
        threadId,
        workspaceConfiguration: {
          expectedRevision: 0,
          primaryBindingId: "api",
          bindings: [
            { id: "api", label: "API", sourcePath: api, mode: "current" },
            {
              id: "web",
              label: "Web",
              sourcePath: web,
              mode: "new-worktree",
              baseRef: "main",
              branch: "task/smoke",
            },
          ],
        },
      });
      const ready = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.filter((item) =>
          item.kind === "snapshot"
            ? item.projection.thread.workspace?.state === "ready"
            : item.kind === "event" &&
              item.event.type === "thread.metadata-updated" &&
              item.event.payload.workspace?.state === "ready",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("20 seconds"),
      );
      assert.equal(ready.length, 1, "Durable preparation must publish completion");
    }),
  );
  await client((rpc) =>
    Effect.gen(function* () {
      const list = yield* rpc[WS_METHODS.quickActionsList]({});
      assert(list.some((entry) => entry.id === action.id));
      const stale = yield* rpc[WS_METHODS.quickActionsSave]({
        action: { ...action, name: "stale" },
        expectedRevision: 0,
      }).pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      const context = yield* rpc[WS_METHODS.actionContext]({ projectId, threadId });
      assert.equal(context.workspaceRevision, 1);
      assert.deepEqual(
        context.repositories.map((entry) => entry.id),
        ["api", "web"],
      );
      for (const entry of context.repositories)
        assert.equal(
          NodeFS.readFileSync(join(entry.repository.path, "shared.txt"), "utf8"),
          `${entry.id}\n`,
        );
      assert.notEqual(
        context.repositories[1]!.repository.path,
        web,
        "A new-worktree binding must not resolve to its source checkout",
      );
      const target = { threadId, bindingId: "web", expectedRevision: 1 };
      const legacy = yield* rpc[WS_METHODS.vcsSwitchRef]({ cwd: api, refName: "main" }).pipe(
        Effect.result,
      );
      assert.equal(legacy._tag, "Failure", "Unscoped legacy Git mutations must be blocked");
      const terminal = yield* rpc[WS_METHODS.workspaceTerminal]({
        ...target,
        terminalId: "repo:web:fixture",
      });
      const reopened = yield* rpc[WS_METHODS.terminalOpen]({
        threadId,
        terminalId: "repo:web:fixture",
        cwd: api,
      });
      assert.equal(reopened.cwd, terminal.cwd);
      assert.notEqual(reopened.cwd, api);
      yield* rpc[WS_METHODS.terminalClose]({ threadId, terminalId: "repo:web:fixture" });
    }),
  );
  if (liveClaude) await liveTurn("first");
  await stop();
  await start();
  if (liveClaude) await liveTurn("resumed");
  const restarted = (await (await request(`${origin}/.well-known/t3/environment`)).json()) as {
    environmentId: string;
  };
  assert.equal(restarted.environmentId, identity);
  await client((rpc) =>
    Effect.gen(function* () {
      const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
      assert.equal(projection.thread.workspace?.state, "ready");
      assert.equal(projection.thread.workspace?.bindings.length, 2);
      assert((yield* rpc[WS_METHODS.quickActionsList]({})).some((entry) => entry.id === action.id));
    }),
  );
  if (liveClaude)
    process.stdout.write(
      "PASS: live Claude edited both actual checkouts and resumed the same native session after a server restart (full-access mode).\n",
    );
  process.stdout.write(
    "PASS: isolated HTTP/auth, matching protocol/frontend, two RPC clients, action revisions, durable mixed checkout preparation, per-repo action context, scoped terminal reopen, legacy Git guard, restart identity and persistence.\n",
  );
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}
