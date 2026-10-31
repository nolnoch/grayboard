// The hosted grayboard extension shared by pi (#279) and omp (#280): an
// adapter-owned grant (hosted-core Login), the server's tools proxied with the
// raw session id in `_meta`, and the delivery lease held by hosted-core's
// Controller. An entry file (entry-pi.ts, entry-omp.ts) adapts the harness's
// events, tool registration and message API to `Harness`.
//
// pi and omp create the extension runtime anew for every session (startup,
// /new, /resume, /fork, /reload), so the state here is one session's; what
// outlives a session (the name a /new carries, the registry of live session
// files) sits on globalThis under a registered symbol.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthProvider, CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import { Controller, type Status } from "../hosted-core/src/controller.ts";
import { Login } from "../hosted-core/src/login.ts";
import { AccessExpired, accessExpiry, DeliveryHeldElsewhere, Refusal, type Identity, type Item } from "../hosted-core/src/model.ts";
import type { HostPort } from "../hosted-core/src/port.ts";
import { hostTools, outputOf, snapshotTools, ToolProxy, type CallHooks, type NativeTool } from "../hosted-core/src/proxy.ts";
import { AncestryError } from "../hosted-core/src/sessions.ts";
import { deliveryPath, FileStorage, sessionPath, tryDelivery, waitDelivery } from "../hosted-core/src/storage.ts";
import type { Lock } from "../hosted-core/src/lock.ts";
import { end, register, type Temporary } from "../hosted-core/src/children.ts";
import { render, wakes } from "../hosted-core/src/channel.ts";
import { Wire, type WireOptions } from "../hosted-core/src/wire.ts";
import { failureMessage } from "../hosted-core/src/diagnostics.ts";
import { boardNotification, dmNotification } from "../../src/core/tools.ts";
import { GRAYBOARD_SESSION_META } from "../../src/server/oauth-config.ts";
import { openBrowser } from "../../src/shared/browser.ts";

export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type SessionInfo = { id: string; file?: string; parentFile?: string; reason: StartReason };
// A harness's own subagent marker: not a child, or a child of `root` (absent
// when the runner gave no parent session, so it can't be attributed).
export type Marker = { child: false } | { child: true; root?: string };
export type Level = "info" | "warning" | "error";

export interface Harness {
  readonly name: string;     // "pi" | "omp", in messages
  readonly clientId: string; // the server's built-in client: "grayboard-pi" | "grayboard-omp"
  readonly version: string;
  readonly agentDir: string; // state lives under <agentDir>/grayboard/
  marker(): Marker;
  // (Re)registers the tool list; `call` runs one under the current session.
  register(tools: NativeTool[], call: (tool: string, args: Record<string, unknown>) => Promise<CallToolResult>): void;
  // A rendered `<channel>`; `wake` starts a turn (idle) or steers in (mid-run).
  deliver(content: string, wake: boolean): void;
  notify(message: string, level: Level): void;
}

export const LOGIN_ACTION = "run /grayboard login";
export const RESUME_HINT = "run /grayboard resume";
const SOURCE = "grayboard";
// hosted-core's Controller pauses every root with this when the store's
// epoch changes (a login or logout in any process).
const DRIFTED = "Grayboard credential changed";

// Cross-session state for one harness in this process.
type Shared = { carried?: string; live: Map<string, string> };
function shared(harness: string): Shared {
  const key = Symbol.for(`io.github.nolnoch.grayboard/${harness}-sessions`);
  // globalThis carries no symbol index; this slot is ours (Symbol.for, namespaced).
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  return g[key] ??= { live: new Map() };
}

const Config = z.object({ url: z.string().min(1) });
// `<stateDir>/config.json {url}`, written by `grayboard setup --server`.
export function readConfig(stateDir: string): { url: string } | { error: string } {
  const unset = "grayboard is not set up for a server; run `grayboard setup --server <url>`";
  let raw: string;
  try { raw = readFileSync(join(stateDir, "config.json"), "utf8"); }
  catch (error) { return { error: error instanceof Error && "code" in error && error.code === "ENOENT" ? unset : `${unset} (${String(error)})` }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {}
  const config = Config.safeParse(parsed);
  return config.success ? { url: config.data.url } : { error: `${join(stateDir, "config.json")} is invalid; run \`grayboard setup --server <url>\`` };
}

const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: `error: ${message}` }], isError: true });

// The server's inbox event (src/server/application.ts DeliveryEvent), checked
// for its discriminants and the sender fields read here; the rest is core's
// own shape, which dmNotification and boardNotification render.
const InboxEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), message: z.looseObject({ id: z.number(), sender: z.string(), body: z.string() }) }),
  z.object({ kind: z.literal("board"), item: z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.literal("push"), post: z.looseObject({ author: z.string(), body: z.string() }) }),
    z.looseObject({ kind: z.literal("digest"), board: z.string() }),
  ]) }),
]);

// The channel params core builds for an inbox item, with human="true" on
// what the user's own human (`<email>/human`, the Slack bridge) sent.
export function channelParams(item: Item, identity: Identity): { content: string; meta: Record<string, string> } {
  const event = InboxEvent.parse(item.event);
  const human = `${identity.user.email}/human`;
  if (event.kind === "direct") {
    // Validated above for what is read here; the server built the rest as core's DirectMessage.
    const message = event.message as unknown as Parameters<typeof dmNotification>[0];
    const params = dmNotification(message, identity.identity_full);
    if (event.message.sender === human) params.meta.human = "true";
    return params;
  }
  // Same: core's Pending, as the server queued it.
  const pending = event.item as unknown as Parameters<typeof boardNotification>[0];
  const params = boardNotification(pending);
  if (event.item.kind === "push" && event.item.post.author === human) params.meta.human = "true";
  return params;
}

type Role = { kind: "root" } | { kind: "child"; root: string } | { kind: "loose" };

// One session's extension runtime, driven by an entry file's event handlers.
export interface Grayboard {
  start(session: SessionInfo): Promise<void>;
  shutdown(reason: ShutdownReason): Promise<void>;
  instructions(): Promise<string | undefined>; // the server's instructions, for the system prompt
  command(args: string): Promise<void>;        // `/grayboard <args>`
  status(): Promise<string>;
}

export function createGrayboard(h: Harness): Grayboard {
  const stateDir = join(h.agentDir, "grayboard");
  const config = readConfig(stateDir);
  const state = shared(h.name);
  const log = (message: string, level: Level = "info") => { if (!closed) h.notify(`grayboard: ${message}`, level); };

  let closed = false;
  let session: SessionInfo | undefined;
  let role: Role = { kind: "root" };
  let notice: string | undefined;     // shown once, in the next tool result
  let held: string | undefined;       // set while another process holds delivery for this root
  let loginNote: string | undefined;  // the latest sign-in diagnostic
  let signedOut = false;              // a start failed for want of a sign-in
  let outAnnounced = false;           // this sign-out was already announced in this session
  let controller: Controller | undefined, lock: Lock | undefined, storage: FileStorage | undefined, proxy: ToolProxy | undefined;
  let waiter: AbortController | undefined;
  let watcher: { dispose(): void } | undefined;
  let registered = false;             // a child registered under its root
  let used = false;                   // a call went out under this session's id
  let restarting: Promise<void> | undefined;

  const login = "url" in config ? new Login({
    resource: config.url, clientId: h.clientId, stateDir, harness: h.name, loginAction: LOGIN_ACTION,
    present: url => {
      log(`sign in at ${url}`);
      openBrowser(url, error => log(`couldn't open a browser (${error.message}); open the URL above`, "warning"));
    },
    notify: message => log(message),
    diagnostic: record => { loginNote = `${record.operation}: ${record.state}${record.code ? ` (${record.code})` : ""}: ${record.message}`; },
  }) : undefined;

  let last: string | undefined;
  const auth: AuthProvider = {
    token: async () => (last = await login!.token()),
    onUnauthorized: async () => login!.unauthorized(last ?? ""),
  };
  const wireOptions = (mode: "push" | "poll"): WireOptions => ({
    url: login!.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: h.clientId, version: h.version }, delivery: { mode, source: SOURCE },
  });

  // ---- tools ----

  const call = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    if ("error" in config) return failure(config.error);
    if (!proxy || !session) return failure(`the ${h.name} session hasn't started yet`);
    used = true;
    let result = await proxy.call(tool, args, session.id);
    if (role.kind === "child" && registered && result.isError && await unattributed(proxy, session.id)) {
      // The server refuses an unattributed child's call before running it, so
      // one retry after registering again never repeats a write.
      registered = false;
      result = await proxy.call(tool, args, session.id);
    }
    const shown = notice;
    notice = undefined;
    return shown ? { ...result, content: [{ type: "text", text: `grayboard: ${shown}` }, ...result.content] } : result;
  };
  h.register(hostTools(snapshotTools()), call);

  // ---- children ----

  const temporary: Temporary = async (sessionID, run) => {
    const wire = new Wire(wireOptions("poll"), auth, AbortSignal.timeout(10_000), sessionID);
    try { await wire.connect(); return await run(wire); }
    finally { await wire.close().catch(() => {}); }
  };
  // A child registers under its root before its first call; a failed
  // registration fails that call and is retried by the next. The server ends
  // the registration with the root's ownership (a lapsed lease the root then
  // rebinds), so a refused call checks whether it still holds.
  const unattributed = async (p: ToolProxy, id: string) => {
    const who = outputOf(await p.call("whoami", {}, id));
    return !!who && typeof who === "object" && "unbound" in who && who.unbound === true && !("child" in who && who.child === true);
  };
  const childHooks = (root: string, child: string): CallHooks => ({
    beforeCall: async () => {
      if (registered) return;
      await register(temporary, { root, via: [], child });
      registered = true;
    },
    afterCall: async () => {},
  });

  // ---- roots ----

  const port = (id: string, store: FileStorage): HostPort => ({
    harness: h.name, resumeHint: RESUME_HINT, loginAction: LOGIN_ACTION, sessionKey: GRAYBOARD_SESSION_META,
    client: { name: h.clientId, version: h.version }, delivery: { mode: "push", source: SOURCE },
    storage: store,
    place: () => h.name,
    ancestry: async sessionID => {
      if (sessionID !== id) throw new AncestryError(`Grayboard session ${sessionID} isn't this ${h.name} session's root`);
      return { sessionID, root: id, via: [] };
    },
    credential: login!.credential(),
    approval: null,
    admit: async (_e, item, _stableID, identity) => {
      if (closed) throw new Refusal("paused", `the ${h.name} session closed`);
      const params = channelParams(item, identity);
      h.deliver(render(params, SOURCE), wakes(item.actionable, params.meta));
    },
  });

  const newProxy = (mode: "push" | "poll", hooks?: CallHooks) => new ToolProxy({
    wire: wireOptions(mode), harness: h.name, loginAction: LOGIN_ACTION, auth,
    ...(hooks ? { hooks } : {}),
    report: (operation, error) => {
      if (operation === "after") controller?.backgroundFailure("after");
      log(`${operation} failed: ${(error as Error)?.message ?? String(error)}`, "warning");
    },
    onTools: tools => { if (!closed) h.register(tools, call); },
  });

  // A live grant re-lists the server's tools on a fresh connection.
  const connect = async () => {
    if (!proxy) return;
    try { await proxy.connect(); }
    catch (error) { if (!accessExpiry(error)) log(`couldn't reach the server: ${(error as Error).message}`, "warning"); }
  };

  const carry = async (id: string) => {
    if (!storage) return;
    const remembered = await storage.get(`rememberedName:${id}`).catch(() => undefined);
    if (remembered && typeof remembered === "object" && "name" in remembered && typeof remembered.name === "string") state.carried = remembered.name;
  };

  // Starts (or restarts) this root's delivery. `carried` is the outgoing
  // session's name for a /new or /fork.
  const begin = async (carried?: string) => {
    if (!controller || !session || closed) return;
    const id = session.id;
    try {
      const status = carried ? await controller.enroll(id, carried, false) : await controller.resume(id);
      signedOut = false;
      if (carried && status.roots.find(r => r.sessionID === id)?.name !== carried)
        notice = `this session couldn't take the name ${carried} it carried over (${status.message}); it is unbound`;
    } catch (error) {
      const expired = accessExpiry(error);
      if (!expired) { log(`couldn't start delivery: ${(error as Error).message}`, "error"); return; }
      signedOut = true;
      outAnnounced = true;
      log(expired.message, "warning");
    }
  };
  const restart = () => restarting ??= begin().finally(() => { restarting = undefined; });

  // The lock is ours: run the Controller and declare push delivery.
  const own = async (taken: Lock, carried?: string) => {
    if (closed || !session) { taken.release(); return; }
    // A held notice nobody saw yet is no longer true.
    lock = taken; if (notice === held) notice = undefined; held = undefined;
    storage = new FileStorage(sessionPath(stateDir, login!.resource, h.clientId, session.id));
    controller = new Controller(port(session.id, storage));
    await controller.restore().catch(() => {});
    const old = proxy;
    proxy = newProxy("push", controller);
    await old?.close();
    void connect();
    await begin(carried);
  };

  const startRoot = async (carried?: string) => {
    const id = session!.id;
    state.live.set(session!.file ?? `id:${id}`, id);
    const path = deliveryPath(stateDir, login!.resource, h.clientId, id);
    const taken = tryDelivery(path);
    if (taken) return own(taken, carried);
    // Tools only until the other process lets go of this session.
    held = new DeliveryHeldElsewhere(h.name).message;
    notice = held;
    proxy = newProxy("poll");
    void connect();
    waiter = new AbortController();
    void waitDelivery(path, waiter.signal).then(next => own(next), () => {});
  };

  // ---- lifecycle ----

  const start = async (s: SessionInfo) => {
    session = s;
    if ("error" in config) { log(config.error, "warning"); return; }
    const marker = h.marker();
    const parent = s.parentFile ? state.live.get(s.parentFile) : undefined;
    role = marker.child ? (marker.root ? { kind: "child", root: marker.root } : { kind: "loose" })
      : parent ? { kind: "child", root: parent } : { kind: "root" };
    if (role.kind === "loose") log(`this ${h.name} subagent has no parent session, so its calls go out as an unregistered session`, "warning");
    // Grandchildren of this child map to the same top root.
    if (role.kind === "child") state.live.set(s.file ?? `id:${s.id}`, role.root);

    watcher = login!.watch(() => { void credentialChanged(); });
    if (role.kind !== "root") {
      proxy = newProxy("poll", role.kind === "child" ? childHooks(role.root, s.id) : undefined);
      void connect();
      return;
    }
    const carried = s.reason === "new" || s.reason === "fork" ? state.carried : undefined;
    state.carried = undefined;
    await startRoot(carried);
  };

  // A sign-in or sign-out in any process of this harness (the store's epoch).
  const credentialChanged = async () => {
    if (closed) return;
    try { await login!.token(); }
    catch (error) {
      // Signed out here or elsewhere: the Controller's own watch pauses the
      // root; every session says why once, not only the one that logged out.
      const expired = accessExpiry(error);
      if (!expired) log(`couldn't read the sign-in: ${(error as Error)?.message ?? String(error)}`, "warning");
      else if (!outAnnounced) { outAnnounced = true; log(expired.message, "warning"); }
      return;
    }
    outAnnounced = false;
    void connect();
    if (!controller || !session) return;
    const record = controller.status().roots.find(r => r.sessionID === session!.id);
    if (signedOut || record?.state === "paused" && record.message.startsWith(DRIFTED)) await restart();
  };

  const shutdown = async (reason: ShutdownReason) => {
    if (closed) return;
    const id = session?.id;
    if (id && role.kind === "root" && controller && (reason === "new" || reason === "fork")) await carry(id);
    closed = true;
    watcher?.dispose();
    waiter?.abort();
    if (session) state.live.delete(session.file ?? `id:${session.id}`);
    if (id && controller) await controller.shutdown(id, reason === "reload" ? "detach" : "release").catch(() => {});
    if (id && reason !== "reload") {
      const ended = (error: unknown) => h.notify(`grayboard: couldn't end session ${id} on the server: ${(error as Error)?.message ?? String(error)}`, "warning");
      if (role.kind === "child" && registered) await end(temporary, { child: id }).catch(ended);
      // An unattributed child is its own unleased root: ending it frees what
      // its calls bound now, not at the server's idle timeout.
      else if (role.kind === "loose" && used) await temporary(id, wire => wire.call("session_end")).catch(ended);
    }
    await controller?.close().catch(() => {});
    lock?.release();
    await proxy?.close().catch(() => {});
  };

  // System-prompt section: the server's instructions for this session.
  const instructions = async (): Promise<string | undefined> => {
    if (!proxy || !session) return undefined;
    try { return await proxy.instructions(session.id); } catch { return undefined; }
  };

  // ---- /grayboard ----

  // While signed out, a root the sign-out paused restarts on its own after a
  // login; resume can't help, so its line names the login instead.
  const describe = (status: Status, signedIn: boolean) => {
    const shown = (state: string, message: string) => !signedIn && state === "paused" && message.startsWith(DRIFTED) ? `signed out; ${LOGIN_ACTION}` : message;
    return [
      `${status.state}: ${shown(status.state, status.message)}`,
      ...status.roots.map(r => `  ${r.sessionID ?? "-"}${r.name ? ` (${r.name})` : ""}: ${r.state}, ${shown(r.state, r.message)}${r.failure ? ` [last failure: ${r.failure.operation} ${r.failure.code}]` : ""}`),
    ].join("\n");
  };

  const status = async (): Promise<string> => {
    if ("error" in config) return config.error;
    const grant = await login!.read().catch(() => undefined);
    const signedIn = !!grant && !grant.loginRequired && !!grant.access;
    const lines = [
      `server: ${login!.resource}`,
      `sign-in: ${signedIn ? "signed in" : `signed out (${grant?.loginRequired?.reason ?? "never signed in"}); ${LOGIN_ACTION}`}`,
      `session: ${session?.id ?? "not started"} (${role.kind === "child" ? `subagent of ${role.root}` : role.kind === "loose" ? "unattributed subagent" : "root"})`,
    ];
    if (held) lines.push(`delivery: ${held}`);
    if (controller) lines.push(describe(controller.status(), signedIn));
    if (loginNote) lines.push(`last sign-in event: ${loginNote}`);
    return lines.join("\n");
  };

  const command = async (args: string): Promise<void> => {
    const verb = args.trim().split(/\s+/)[0] || "status";
    if ("error" in config) { log(config.error, "warning"); return; }
    try {
      if (verb === "login") {
        await login!.login();
        log("signed in");
        await connect();
        if (controller) await restart();
      } else if (verb === "logout") {
        // Before the store changes: this session's own watch sees the new
        // epoch too, and the line below already says it.
        outAnnounced = true;
        try { await login!.logout(); } catch (error) { outAnnounced = false; throw error; }
        log(`signed out; every ${h.name} session on this server pauses until ${LOGIN_ACTION}`);
      } else if (verb === "resume") {
        if (!controller || !session) { log(held ?? `only a root session with delivery resumes`, "warning"); return; }
        await restart();
        if (signedOut) return; // begin said why
        const record = controller.status().roots.find(r => r.sessionID === session!.id);
        log(record ? `${record.state}: ${record.message}` : describe(controller.status(), true));
      } else if (verb === "status") log(await status());
      else log(`unknown subcommand ${verb}; use login, logout, resume or status`, "warning");
    } catch (error) {
      const expired = accessExpiry(error);
      log(expired ? expired.message : error instanceof AccessExpired || error instanceof Refusal ? error.message : failureMessage(error, RESUME_HINT) + ` (${(error as Error).message})`, "error");
    }
  };

  return { start, shutdown, instructions, command, status };
}
