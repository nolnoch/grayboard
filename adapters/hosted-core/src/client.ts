// One hosted harness session's connection to the server (#444), for every
// kind of session a harness adapter runs: a root (under root.ts's
// RootDelivery), and pi/omp's subagent children and unattributed (loose)
// sessions. The host builds the Login (its sign-in presentation differs);
// this holds the rest: the bearer, the wire options every request sends
// (the generic session key and the declared delivery), the credential watch
// that says a sign-out once, the one tool-call error wrapper, its tool
// proxies, and a session's end.
//
// Not vendored to OpenCode V2 (scripts/sync_hosted_core.ts): OpenCode owns
// the grant and the transport.
import type { AuthProvider, CallToolResult } from "@modelcontextprotocol/client";
import type { Temporary } from "./children.js";
import { failureMessage } from "./diagnostics.js";
import type { Login } from "./login.js";
import { accessExpiry } from "./model.js";
import { failure, ToolProxy, type CallHooks, type NativeTool } from "./proxy.js";
import { SubscriberError, Wire, type WireOptions } from "./wire.js";
import { GRAYBOARD_SESSION_META } from "../../../src/shared/session_meta.ts";

export type Level = "info" | "warning" | "error";
export type Disposable = { dispose(): void };

export type HostedClientOptions = {
  harness: string;          // "pi" | "omp" | "Claude Code", in messages
  clientId: string;         // the server's built-in client
  version: string;
  login: Login;             // built by the host: its sign-in presentation differs
  source: string;           // channel source ("grayboard" | "plugin:grayboard:grayboard")
  loginAction: string;
  resumeHint: string;       // how to restart a paused root (the Controller's pause records)
  retryHint: string;        // a failed tool call's remedy: pi/omp "call the tool again"; Claude Code its resume hint
  roots?: string[];         // ToolProxy attachment roots
  env?: Record<string, string | undefined>;
  log(message: string, level: Level): void;
};

export const message = (error: unknown) => (error as Error)?.message ?? String(error);

// A failed call's text: failureMessage's, and where that names no cause (its
// refusal and generic text) the error's own message, the only detail there
// is (a JSON-RPC error, a refused connect's HTTP body). That message is the
// server's or the network's free text, shown to the model and the user, so
// control and bidi characters (wire.ts's holderText class) become spaces and
// it is capped.
const DETAIL_MAX = 300;
export function failureText(error: unknown, hint: string): string {
  const text = failureMessage(error, hint);
  if (!(error instanceof SubscriberError) && text !== failureMessage(undefined, hint)) return text;
  const detail = message(error).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  return `${text} (${detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail})`;
}

export class HostedClient {
  readonly auth: AuthProvider;
  private last: string | undefined;
  // The live proxies this client made: a sign-in re-lists the tools on each.
  private readonly proxies = new Set<ToolProxy>();
  private readonly listeners = new Set<(signedIn: boolean) => void>();
  private outAnnounced = false;

  constructor(readonly options: HostedClientOptions) {
    const login = options.login;
    this.auth = {
      token: async () => (this.last = await login.token()),
      onUnauthorized: async () => login.unauthorized(this.last ?? ""),
    };
  }

  get login(): Login { return this.options.login; }

  wireOptions(mode: "push" | "poll"): WireOptions {
    return { url: this.login.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: this.options.clientId, version: this.options.version }, delivery: { mode, source: this.options.source } };
  }

  // One short-lived poll wire under `sessionID` (a child's register and end, a session's end).
  temporary: Temporary = async (sessionID, run) => {
    const wire = new Wire(this.wireOptions("poll"), this.auth, AbortSignal.timeout(10_000), sessionID);
    try { await wire.connect(); return await run(wire); }
    finally { await wire.close().catch(() => {}); }
  };

  // session_end for a session no lease ends (an unattributed child, a
  // tools-only root whose calls bound it): frees what it bound now, not at
  // the server's idle sweep. Every failure is said, a sign-out included: the
  // session then stays bound until that sweep.
  async endSession(id: string): Promise<void> {
    try { await this.temporary(id, wire => wire.call("session_end")); }
    catch (error) { this.options.log(`couldn't end session ${id} on the server: ${message(error)}`, "warning"); }
  }

  proxy(mode: "push" | "poll", o: { hooks?: CallHooks; onTools(tools: NativeTool[]): void; onAfterFailure?(): void }): ToolProxy {
    const proxy = new ToolProxy({
      wire: this.wireOptions(mode), harness: this.options.harness, loginAction: this.options.loginAction, auth: this.auth,
      ...(this.options.roots ? { roots: this.options.roots } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(o.hooks ? { hooks: o.hooks } : {}),
      report: (operation, error) => {
        if (operation === "after") o.onAfterFailure?.();
        this.options.log(`${operation} failed: ${message(error)}`, "warning");
      },
      onTools: tools => o.onTools(tools),
    });
    this.proxies.add(proxy);
    return proxy;
  }
  // A replaced proxy: its calls in flight finish on it (closing it under them
  // would abort a write the server may have committed), then it closes.
  async retire(proxy: ToolProxy): Promise<void> {
    this.proxies.delete(proxy);
    await proxy.retire().catch(error => this.options.log(`couldn't close a replaced connection: ${message(error)}`, "warning"));
  }
  async close(proxy: ToolProxy): Promise<void> {
    this.proxies.delete(proxy);
    await proxy.close().catch(error => this.options.log(`couldn't close the connection: ${message(error)}`, "warning"));
  }

  // A fresh native connection, which re-lists the server's tools. Signed out
  // is the tools' own error to say; anything else is said here.
  async connect(proxy: ToolProxy): Promise<void> {
    try { await proxy.connect(); }
    catch (error) { if (!accessExpiry(error)) this.options.log(`couldn't reach the server: ${message(error)}`, "warning"); }
  }

  // The one tool-call error wrapper: a call that throws (a beforeCall
  // refusal, the transport, a JSON-RPC error) comes back as an error result
  // with the retry hint and failureText's detail. `proxy` is any call (pi's
  // child wraps its unattributed retry, so a converted failure never
  // triggers that retry's whoami probe).
  async call(proxy: Pick<ToolProxy, "call">, tool: string, args: Record<string, unknown>, sessionID: string): Promise<CallToolResult> {
    try { return await proxy.call(tool, args, sessionID); }
    catch (error) { return failure(failureText(error, this.options.retryHint)); }
  }

  // One Login.watch per session: a change of the grant store's epoch (a
  // login or logout in any process of this harness). A sign-out is said once
  // per sign-out in this session, unless markAnnounced() was called; a
  // sign-in re-lists the tools on every live proxy. Subscribers hear both.
  watch(): Disposable {
    return this.login.watch(() => { void this.changed(); });
  }
  private async changed() {
    try { await this.login.token(); }
    catch (error) {
      const expired = accessExpiry(error);
      if (!expired) { this.options.log(`couldn't read the sign-in: ${message(error)}`, "warning"); return; }
      if (!this.outAnnounced) { this.outAnnounced = true; this.options.log(expired.message, "warning"); }
      for (const fn of [...this.listeners]) fn(false);
      return;
    }
    this.outAnnounced = false;
    for (const proxy of [...this.proxies]) void this.connect(proxy);
    for (const fn of [...this.listeners]) fn(true);
  }
  onChange(fn: (signedIn: boolean) => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => { this.listeners.delete(fn); } };
  }

  // The current sign-out was already said in this session.
  get announced(): boolean { return this.outAnnounced; }
  // pi's /grayboard logout says the sign-out itself, before the store
  // changes; a logout that failed un-marks it.
  markAnnounced(announced = true): void { this.outAnnounced = announced; }
}
