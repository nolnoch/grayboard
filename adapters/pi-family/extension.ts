// The hosted grayboard extension shared by pi (#279) and omp (#280): an
// adapter-owned grant (hosted-core Login), the server's tools proxied with the
// raw session id in `_meta` (hosted-core's HostedClient), and a root's
// delivery lease held by hosted-core's RootDelivery. An entry file
// (entry-pi.ts, entry-omp.ts) adapts the harness's events, tool registration
// and message API to `Harness`.
//
// Each `createGrayboard` is one session's runtime: pi creates the extension
// anew for every session (startup, /new, /resume, /fork, /reload), and omp's
// entry creates one per session id on its session_switch and session_branch.
// What outlives a session (the name a /new carries, the registry of live
// session files, the items a root admitted) sits on globalThis under a
// registered symbol. A root's delivery is RootDelivery's; this keeps the
// session's role (root, subagent child, unattributed subagent), a child's
// registration under its root, the system prompt's instructions and
// `/grayboard`.
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { channelParams, render, wakes } from "../hosted-core/src/channel.ts";
import { end, register } from "../hosted-core/src/children.ts";
import { HostedClient, type Disposable } from "../hosted-core/src/client.ts";
import { readHostedConfig } from "../hosted-core/src/config.ts";
import { DRIFTED, type Status } from "../hosted-core/src/controller.ts";
import { failureMessage } from "../hosted-core/src/diagnostics.ts";
import { Login } from "../hosted-core/src/login.ts";
import { AccessExpired, accessExpiry, Refusal } from "../hosted-core/src/model.ts";
import { failure, hostTools, outputOf, snapshotTools, type CallHooks, type NativeTool, type ToolProxy } from "../hosted-core/src/proxy.ts";
import { RootDelivery } from "../hosted-core/src/root.ts";
import { openBrowser } from "../../src/shared/browser.ts";
import { describeLocation } from "../../src/shared/identity.ts";

export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type SessionInfo = { id: string; file?: string; parentFile?: string; reason: StartReason };
// A harness's own subagent marker: not a child, or a child of `root` (absent
// when the runner gave no parent session, so it can't be attributed) through
// the intermediate subagent sessions `via`, outermost first (audit only).
export type Marker = { child: false } | { child: true; root?: string; via?: string[] };
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
// A tool call that failed: the call itself is what to retry.
const RETRY_HINT = "call the tool again";
const SOURCE = "grayboard";

// A tool's arguments and MCP result as both entries' tools take and return
// them: text and image blocks, and an error said in text when the server
// gave none.
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export const toolArgs = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" ? Object.fromEntries(Object.entries(params)) : {};
export function toolResult(server: string, tool: string, result: CallToolResult) {
  const content = result.content.flatMap((block): ToolContent[] =>
    block.type === "text" ? [{ type: "text", text: block.text }]
    : block.type === "image" ? [{ type: "image", data: block.data, mimeType: block.mimeType }] : []);
  if (result.isError && !content.some(block => block.type === "text" && block.text))
    content.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
  return { content, details: { server, tool }, ...(result.isError ? { isError: true as const } : {}) };
}
// `/grayboard`'s registration, the same in both harnesses.
export const COMMAND = {
  description: "grayboard: login | logout | resume | status",
  getArgumentCompletions: (prefix: string) => ["login", "logout", "resume", "status"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
};

// Cross-session state for one harness in this process: the name a /new or
// /fork carries, the live session files (file → root id), and per root
// session the stable ids of items it admitted, which a /reload keeps (the
// lease stays) while the Controller's own admission set doesn't outlive it.
type Shared = { carried?: string; live: Map<string, string>; admitted: Map<string, Set<string>> };
const ADMITTED_LIMIT = 256;
function shared(harness: string): Shared {
  const key = Symbol.for(`io.github.nolnoch.grayboard/${harness}-sessions`);
  // globalThis carries no symbol index; this slot is ours (Symbol.for, namespaced).
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  const slot = g[key] ??= { live: new Map(), admitted: new Map() };
  // A /reload after `grayboard update` may find the slot an older bundle made.
  slot.admitted ??= new Map();
  return slot;
}

type Role = { kind: "root" } | { kind: "child"; root: string; via: string[] } | { kind: "loose" };

// One session's extension runtime, driven by an entry file's event handlers.
export interface Grayboard {
  start(session: SessionInfo): Promise<void>;
  shutdown(reason: ShutdownReason): Promise<void>;
  instructions(): Promise<string | undefined>; // the server's instructions, for the system prompt
  command(args: string): Promise<void>;        // `/grayboard <args>`
  status(): Promise<string>;
  idle(): Promise<void>;                       // a subagent's run ended: its child slot goes back until its next call
}

export function createGrayboard(h: Harness): Grayboard {
  const stateDir = join(h.agentDir, "grayboard");
  const config = readHostedConfig(stateDir);
  const state = shared(h.name);
  // Said until this session's shutdown finishes, so its own records (a
  // release that failed) land inside the harness's shutdown handler.
  const log = (message: string, level: Level = "info") => { if (!done) h.notify(`grayboard: ${message}`, level); };
  // The bind's `where` (peer_list, a name refusal's holder text): this
  // process's checkout, as server mode's `grayboard mcp` sent it.
  const place = describeLocation(process.cwd()) ?? h.name;

  let closed = false;                 // shutdown began
  let done = false;                   // shutdown finished
  let session: SessionInfo | undefined;
  let role: Role = { kind: "root" };
  let loginNote: string | undefined;  // the latest sign-in diagnostic
  let logoutWarnings: string[] | undefined; // a running logout's warnings, which its own line says
  let root: RootDelivery | undefined; // a root session's delivery
  let proxy: ToolProxy | undefined;   // a child's or unattributed session's connection
  let watcher: Disposable | undefined; // its credential watch
  let registration: Promise<void> | undefined; // a child's register under its root, until it fails
  let releasing: Promise<void> | undefined;    // an idle child's end, which its next register waits behind
  let registered = false;             // that register succeeded
  let attempted = false;              // a register went out (a timed-out one may have committed)
  let used = false;                   // a call went out under this (non-root) session's id
  const inflight = new Set<Promise<CallToolResult>>(); // calls running now, which an idle end lands after

  const login = "url" in config ? new Login({
    resource: config.url, clientId: h.clientId, stateDir, harness: h.name, loginAction: LOGIN_ACTION,
    present: url => {
      log(`sign in at ${url}`);
      openBrowser(url, error => log(`couldn't open a browser (${error.message}); open the URL above`, "warning"));
    },
    notify: message => log(message),
    // A queued revoke or a refresh whose outcome is unknown leaves a grant live
    // on the server or this session signed out: said at once, not only in
    // /grayboard status, which a restart forgets.
    diagnostic: record => {
      loginNote = `${record.operation}: ${record.state}${record.code ? ` (${record.code})` : ""}: ${record.message}`;
      if (record.state !== "degraded" && record.state !== "paused") return;
      if (logoutWarnings) logoutWarnings.push(record.message);
      else log(record.message, "warning");
    },
  }) : undefined;

  const client = login ? new HostedClient({
    harness: h.name, clientId: h.clientId, version: h.version, login, source: SOURCE,
    loginAction: LOGIN_ACTION, resumeHint: RESUME_HINT, retryHint: RETRY_HINT, log,
  }) : undefined;

  // ---- tools ----

  const call = (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const running = dispatch(tool, args);
    inflight.add(running);
    const settled = () => { inflight.delete(running); };
    running.then(settled, settled);
    return running;
  };
  const dispatch = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    if ("error" in config) return failure(config.error);
    if (root) return root.call(tool, args);
    if (!proxy || !session) return failure(`the ${h.name} session hasn't started yet`);
    used = true;
    const p = proxy;
    return client!.call({ call: (name, a, id) => attributed(p, name, a, id) }, tool, args, session.id);
  };
  // The server refuses an unattributed child's call before running it, so
  // one retry after registering again never repeats a write. The client's
  // error wrapper sits outside it: a converted failure never probes.
  const attributed = async (p: ToolProxy, tool: string, args: Record<string, unknown>, id: string): Promise<CallToolResult> => {
    let result = await p.call(tool, args, id);
    if (role.kind === "child" && registered && result.isError && await unattributed(p, id)) {
      registered = false; registration = undefined;
      result = await p.call(tool, args, id);
    }
    return result;
  };
  h.register(hostTools(snapshotTools()), call);

  // ---- children ----

  // A child registers under its root before its first call or instructions
  // fetch (the server's instructions for an unregistered session tell it to
  // bind, which a child can't); a failed registration fails that call and is
  // retried by the next. Concurrent calls share one register. The server ends
  // the registration with the root's ownership (a lapsed lease the root then
  // rebinds), so a refused call checks whether it still holds.
  const unattributed = async (p: ToolProxy, id: string) => {
    const who = outputOf(await p.call("whoami", {}, id));
    return !!who && typeof who === "object" && "unbound" in who && who.unbound === true && !("child" in who && who.child === true);
  };
  // A child's root and the subagents between, as the harness says at each
  // register: omp's main session can change under a live subagent (a /new
  // while it sits idle), and a revived one registers under the new root.
  const placement = (fixed: { root: string; via: string[] }) => {
    const marker = h.marker();
    return marker.child && marker.root ? { root: marker.root, via: marker.via ?? [] } : fixed;
  };
  // After shutdown begins none starts: shutdown ends only a register it saw.
  // One after an idle end goes out once that end has landed.
  const enlist = (fixed: { root: string; via: string[] }, child: string): Promise<void> => {
    if (registration) return registration;
    if (closed) return Promise.reject(new Error(`the ${h.name} session closed`));
    attempted = true;
    const pending: Promise<void> = (releasing ?? Promise.resolve()).then(() => register(client!.temporary, { ...placement(fixed), child })).then(
      () => { if (registration === pending) { registered = true; proxy?.forget(child); } },
      error => { if (registration === pending) registration = undefined; throw error; });
    return registration = pending;
  };
  const childHooks = (fixed: { root: string; via: string[] }, child: string): CallHooks => ({
    beforeCall: () => enlist(fixed, child),
    afterCall: async () => {},
  });
  const endFailed = (id: string) => (error: unknown) =>
    log(`couldn't end session ${id} on the server: ${(error as Error)?.message ?? String(error)}`, "warning");
  // omp keeps a finished subagent live (revivable) for its idle TTL, so a
  // child released only at shutdown would hold a slot long after its run: a
  // fan-out of 128 within that TTL would fill the root's cap. An idle child
  // ends once the calls already running land (omp may start the next run
  // before this one's agent_end reaches us); its next call registers it again.
  const idle = async (): Promise<void> => {
    if (closed || role.kind !== "child" || !session || !attempted) return;
    const id = session.id, pending = registration, sure = registered, running = [...inflight];
    registration = undefined; registered = false; attempted = false;
    const run = (async () => {
      await Promise.allSettled(running);
      const committed = sure || (pending ? await pending.then(() => true, () => false) : false);
      await end(client!.temporary, { child: id }).catch(committed ? endFailed(id) : () => {});
    })();
    releasing = run;
    await run;
    if (releasing === run) releasing = undefined;
  };

  // ---- lifecycle ----

  const start = async (s: SessionInfo) => {
    session = s;
    if ("error" in config) { log(config.error, "warning"); return; }
    const marker = h.marker();
    const parent = s.parentFile ? state.live.get(s.parentFile) : undefined;
    role = marker.child ? (marker.root ? { kind: "child", root: marker.root, via: marker.via ?? [] } : { kind: "loose" })
      : parent ? { kind: "child", root: parent, via: [] } : { kind: "root" };
    if (role.kind === "loose") log(`this ${h.name} subagent has no parent session, so its calls go out as an unregistered session`, "warning");
    if (role.kind !== "root") {
      // Grandchildren of this child map to the same top root.
      if (role.kind === "child") state.live.set(s.file ?? `id:${s.id}`, role.root);
      watcher = client!.watch();
      proxy = client!.proxy("poll", { ...(role.kind === "child" ? { hooks: childHooks(role, s.id) } : {}), onTools: tools => { if (!closed) h.register(tools, call); } });
      void client!.connect(proxy);
      return;
    }
    state.live.set(s.file ?? `id:${s.id}`, s.id);
    const carried = s.reason === "new" || s.reason === "fork" ? state.carried : undefined;
    state.carried = undefined;
    const id = s.id;
    root = new RootDelivery(client!, {
      sessionID: id, stateDir, place: () => place, push: true, ...(carried ? { carried } : {}),
      // Idempotent per stableID across this root's runtimes: a /reload keeps
      // the lease, so the reloaded Controller re-reads an item admitted before
      // the reload whose receipt hadn't landed, and must not deliver it twice.
      admit: async (item, stableID, identity) => {
        let admitted = state.admitted.get(id);
        if (!admitted) state.admitted.set(id, admitted = new Set());
        if (admitted.has(stableID)) return;
        const params = channelParams(item, identity);
        h.deliver(render(params, SOURCE), wakes(item.actionable, params.meta));
        admitted.add(stableID);
        if (admitted.size > ADMITTED_LIMIT) admitted.delete(admitted.values().next().value!);
      },
      onTools: tools => h.register(tools, call),
    });
    await root.start();
  };

  const shutdown = async (reason: ShutdownReason) => {
    if (closed) return;
    closed = true;
    const id = session?.id;
    if (session) state.live.delete(session.file ?? `id:${session.id}`);
    if (root) {
      const carry = reason === "new" || reason === "fork";
      const carried = await root.shutdown(reason === "reload" ? "detach" : "release", { carry });
      if (carry) state.carried = carried;
    } else {
      watcher?.dispose();
      // An idle end still landing finishes first: omp caps shutdown handlers at 2 s.
      await releasing;
      if (id && reason !== "reload") {
        // A register still in flight, or one that failed after the server
        // committed it (a timeout), may have registered this child: it ends
        // either way, and says so only when the end of a sure one fails.
        if (role.kind === "child" && attempted) {
          await registration?.catch(() => {});
          await end(client!.temporary, { child: id }).catch(registered ? endFailed(id) : () => {});
        }
        // An unattributed child is its own unleased root: ending it frees what
        // its calls bound now, not at the server's idle timeout.
        else if (role.kind === "loose" && used) await client!.endSession(id);
      }
      if (proxy) await client!.close(proxy);
    }
    if (id && reason !== "reload") state.admitted.delete(id);
    done = true;
  };

  // System-prompt section: the server's instructions for this session. A
  // child registers first: the text an unregistered session gets tells it to
  // bind, which the server refuses a child.
  const instructions = async (): Promise<string | undefined> => {
    if (!session) return undefined;
    try {
      if (root) return await root.instructions();
      if (!proxy) return undefined;
      if (role.kind === "child") await enlist(role, session.id);
      return await proxy.instructions(session.id);
    } catch { return undefined; }
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
      `session: ${session?.id ?? "not started"} (${role.kind === "child" ? `subagent of ${placement(role).root}` : role.kind === "loose" ? "unattributed subagent" : "root"})`,
    ];
    const delivery = root?.status();
    if (delivery?.held) lines.push(`delivery: ${delivery.held}`);
    if (delivery?.error) lines.push(`delivery: ${delivery.error}`);
    if (delivery?.controller) lines.push(describe(delivery.controller, signedIn));
    if (loginNote) lines.push(`last sign-in event: ${loginNote}`);
    return lines.join("\n");
  };

  const command = async (args: string): Promise<void> => {
    const verb = args.trim().split(/\s+/)[0] || "status";
    if ("error" in config) { log(config.error, "warning"); return; }
    try {
      if (verb === "login") {
        // Its own failure line: resume can't mend a sign-in that didn't happen.
        try { await login!.login(); }
        catch (error) { log(`sign-in failed: ${(error as Error).message}; ${LOGIN_ACTION} to try again`, "error"); return; }
        log("signed in");
        // The watch's restart and this one are one epoch-guarded path.
        if (root) await root.credentialChanged();
        else if (proxy) await client!.connect(proxy);
      } else if (verb === "logout") {
        // Before the store changes: this session's own watch sees the new
        // epoch too, and the line below already says it.
        client!.markAnnounced();
        const warnings: string[] = logoutWarnings = [];
        try { await login!.logout(); }
        catch (error) {
          client!.markAnnounced(false);
          log(`sign-out failed: ${(error as Error).message}; run /grayboard logout to try again`, "error");
          return;
        } finally { logoutWarnings = undefined; }
        const pauses = `every ${h.name} session on this server pauses until ${LOGIN_ACTION}`;
        // A revoke that failed leaves the grant live on the server until it is sent again.
        if (warnings.length) log(`${warnings.join("; ")}; ${pauses}`, "warning");
        else log(`signed out; ${pauses}`);
      } else if (verb === "resume") {
        if (!root || !session) { log("only a root session with delivery resumes", "warning"); return; }
        // An explicit resume always answers: a start says a sign-out only if nothing has yet.
        const said = client!.announced;
        await root.resume();
        const delivery = root.status();
        if (delivery.signedOut) { if (said) log(delivery.signedOut.message, "warning"); return; }
        // A lock that still can't be taken was said by the retry.
        if (delivery.error) return;
        if (delivery.held) { log(delivery.held, "warning"); return; }
        if (!delivery.controller) { log("delivery isn't running in this session", "warning"); return; }
        const record = delivery.controller.roots.find(r => r.sessionID === session!.id);
        log(record ? `${record.state}: ${record.message}` : describe(delivery.controller, true));
      } else if (verb === "status") log(await status());
      else log(`unknown subcommand ${verb}; use login, logout, resume or status`, "warning");
    } catch (error) {
      const expired = accessExpiry(error);
      log(expired ? expired.message : error instanceof AccessExpired || error instanceof Refusal ? error.message : failureMessage(error, RESUME_HINT) + ` (${(error as Error).message})`, "error");
    }
  };

  return { start, shutdown, instructions, command, status, idle };
}
