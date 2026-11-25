// Static service run-token mode for the hosted-core harnesses (pi, omp,
// Claude Code; #1243, #270 D3): a launcher mints a run token with its
// service credential (`client_credentials`) and starts the harness with it in
// the environment. No browser, no grant store, no refresh: the issuer is
// pinned before the token is sent anywhere, whoami must name a service (the
// launcher's, when GRAYBOARD_PRINCIPAL names one), and a 401 ends the run.
//
// Inputs come from the launcher's environment only. A repository can reach a
// harness's environment too, so the mode is refused when one tries: a
// variable set after exec (Bun's dotenv autoload in the Claude Code plugin's
// and omp's process, omp's own project .env loading: any grammar their
// parsers accept), a dotenv file in the working directory that names one
// (where the exec-time environment can't be read), or, for Claude Code, a
// project `.claude/settings*.json` naming one (Claude Code puts its `env`
// into the plugin's exec environment, verified on Claude Code 2.1.316).
//
// Not vendored to OpenCode V2 (scripts/sync_hosted_core.ts), whose static
// mode (adapters/opencode-v2/src/lifecycle.ts staticMode) has its own names.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceMetadata, SCOPES, type SignIn } from "./login.js";
import { AccessExpired, Refusal } from "./model.js";
import type { Configuration, CredentialPort, Enrollment } from "./port.js";
import { signOutCause } from "./proxy.js";
import { sha256 } from "./storage.js";
import { NativeWire, ServerUnreachable, subscriberError } from "./wire.js";
import { canonicalEndpoint, issuerEndpoint } from "../../../src/shared/endpoint.ts";
import { GRAYBOARD_SESSION_META } from "../../../src/shared/session_meta.ts";

export const STATIC_AUTH = "GRAYBOARD_AUTH", STATIC_ISSUER = "GRAYBOARD_ISSUER", RUN_TOKEN = "GRAYBOARD_RUN_TOKEN", STATIC_PRINCIPAL = "GRAYBOARD_PRINCIPAL";
const NAMES = [STATIC_AUTH, STATIC_ISSUER, RUN_TOKEN, STATIC_PRINCIPAL];
// OpenCode V2's text (binding.ts NEW_RUN): what a run whose token stopped working needs.
export const NEW_RUN = "the launcher must start a new run with a fresh run token";
// The enrollment's client: no built-in client and no svc_ ID (whoami doesn't say it).
export const SERVICE_CLIENT = "service-credential";
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const PRINCIPAL = /^[^\s/]{1,128}$/;

export type StaticMode = { issuer: string; token: string; principal?: string } | { refused: string };

// The process's environment as exec gave it (Linux's /proc/self/environ,
// which nothing in the process rewrites; omp's readLaunchEnv reads it the
// same way), or undefined where it can't be read.
export function launchEnv(): Record<string, string> | undefined {
  let raw: string;
  try { raw = readFileSync("/proc/self/environ", "utf8"); } catch { return undefined; }
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

// Every key of a parsed JSON value, at any depth.
function* keys(value: unknown): Generator<string> {
  if (Array.isArray(value)) { for (const v of value) yield* keys(v); return; }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) { yield k; yield* keys(v); }
}

// What the repository did to the static-mode variables, if anything: one set
// or changed after exec (`launch`, the exec-time environment), a dotenv file
// in `cwd` naming one, and for each of `settingsDirs` (Claude Code's project
// dir and cwd) a `.claude/settings.json` or `settings.local.json` with one as
// a key anywhere. An unreadable or unparseable file refuses too: it can't be
// shown not to set them.
function repositorySets(env: Record<string, string | undefined>, cwd: string, settingsDirs: string[], launch: Record<string, string> | undefined): string | undefined {
  if (launch) {
    const changed = NAMES.find(name => (env[name] ?? undefined) !== launch[name]);
    if (changed) return `${changed} was set after the harness started (a dotenv file?); the launcher sets it`;
  }
  // Every separator and prefix Bun's dotenv parser takes: `=` or `:`, an optional `export`.
  const dotenv = new RegExp(`^\\s*(export\\s+)?(${NAMES.join("|")})\\s*[=:]`, "m");
  let files: string[] = [];
  try { files = readdirSync(cwd).filter(name => /^\.env(\..+)?$/.test(name)); } catch {}
  for (const file of files) {
    let text: string;
    try { text = readFileSync(join(cwd, file), "utf8"); } catch { return `${file} in the working directory is unreadable`; }
    if (dotenv.test(text)) return `${file} in the working directory sets its variables; the launcher sets them`;
  }
  // Parsed, so an escaped key (`\u0047RAYBOARD_…`) reads as Claude Code reads it;
  // a key anywhere in the file, not only under `env`.
  for (const dir of new Set(settingsDirs)) for (const file of ["settings.json", "settings.local.json"]) {
    let text: string;
    try { text = readFileSync(join(dir, ".claude", file), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return `the project's .claude/${file} is unreadable`; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return `the project's .claude/${file} isn't JSON grayboard can check`; }
    for (const k of keys(parsed)) if (NAMES.includes(k)) return `the project's .claude/${file} sets its variables; the launcher sets them`;
  }
  return undefined;
}

// The mode the launcher's environment asks for: undefined is browser OAuth.
// GRAYBOARD_AUTH=static turns it on; any other value, a missing or malformed
// pin or token, a repository file that sets one of the variables, or a run
// token set without the mode is a refused static mode, never OAuth.
// GRAYBOARD_ISSUER and GRAYBOARD_PRINCIPAL alone, without the mode, are
// ignored (a shell that exports the issuer for another client).
// `settingsDirs`: Claude Code's project dirs to check (others pass none).
// `launch`: the exec-time environment; read from /proc only when `env` is
// this process's own (tests pass one).
export function staticMode(env: Record<string, string | undefined>, cwd: string, settingsDirs: string[] = [], launch: Record<string, string> | undefined = env === process.env ? launchEnv() : undefined): StaticMode | undefined {
  const auth = env[STATIC_AUTH];
  if ((auth === undefined || auth === "") && !env[RUN_TOKEN]) return undefined;
  // The repository first, so a file that set the token alone is named.
  const repository = repositorySets(env, cwd, settingsDirs, launch);
  if (repository) return { refused: `Static mode refused: ${repository}` };
  if (auth === undefined || auth === "") return { refused: `${RUN_TOKEN} is set without ${STATIC_AUTH}=static` };
  if (auth !== "static") return { refused: `${STATIC_AUTH} must be "static" or unset` };
  const issuer = env[STATIC_ISSUER];
  if (!issuer) return { refused: `Static mode needs a pinned issuer (${STATIC_ISSUER})` };
  if (!issuerEndpoint(issuer)) return { refused: `${STATIC_ISSUER} must be an HTTPS URL (or HTTP loopback) without credentials, query or fragment, written as the server lists its issuer` };
  const token = env[RUN_TOKEN];
  if (!token) return { refused: `Static mode needs the launcher's run token (${RUN_TOKEN})` };
  if (!TOKEN.test(token)) return { refused: `${RUN_TOKEN} isn't a run token` };
  const principal = env[STATIC_PRINCIPAL];
  if (principal === undefined || principal === "") return { issuer, token };
  if (!PRINCIPAL.test(principal)) return { refused: `${STATIC_PRINCIPAL} must be a service name` };
  return { issuer, token, principal };
}

export type StaticConfig = {
  resource: string;  // the hosted MCP URL, from setup (config.json, the plugin's server_url)
  clientId: string;  // the harness's built-in client: the wire's display name, and part of the state key
  version: string;
  harness: string;   // "pi" | "omp" | "Claude Code", in messages
  mode: StaticMode;
};

// Run tokens a 401 ended in this process, by SHA-256: a later runtime (pi's
// /new, omp's next session) reads the same environment and fails at once.
const ended = new Set<string>();

// The SignIn of a static run. Holds the token in memory only: never in an
// error, a record, a status line or a file.
export class StaticLogin implements SignIn {
  readonly resource: string;
  readonly stateKey: string;
  readonly static: { issuer?: string; principal?: string; refused?: string };
  // The config without its mode, so nothing that prints this object prints the token.
  readonly #config: Omit<StaticConfig, "mode">;
  readonly #token: string | undefined;
  readonly #fingerprint: string | undefined;
  #verified: Promise<void> | undefined;
  #refusal: Refusal | undefined;

  constructor({ mode, ...config }: StaticConfig) {
    this.#config = config;
    const resource = canonicalEndpoint(config.resource);
    if (!resource) throw new Error("Grayboard resource must be canonical HTTPS (or HTTP loopback), without credentials, query or fragment");
    this.resource = resource.href;
    this.stateKey = `${SERVICE_CLIENT}:${config.clientId}`;
    if ("refused" in mode) {
      this.static = { refused: mode.refused };
      this.#refusal = new Refusal("identity", mode.refused);
    } else {
      this.static = { issuer: mode.issuer, ...(mode.principal ? { principal: mode.principal } : {}) };
      this.#token = mode.token;
      this.#fingerprint = createHash("sha256").update(mode.token).digest("hex");
    }
  }

  private expired() { return new AccessExpired(this.#config.harness, NEW_RUN, "login_required"); }
  get ended(): boolean { return this.#fingerprint !== undefined && ended.has(this.#fingerprint); }

  // The run token once its issuer and principal checked out. Throws the
  // refusal, AccessExpired once a 401 ended it, or ServerUnreachable during an
  // outage at the check (not remembered: the next call checks again).
  async token(): Promise<string> {
    if (this.#refusal) throw this.#refusal;
    if (this.ended) throw this.expired();
    this.#verified ??= this.verify().catch(error => {
      if (error instanceof Refusal && !(error instanceof AccessExpired)) this.#refusal = error;
      this.#verified = undefined;
      throw error;
    });
    await this.#verified;
    if (this.ended) throw this.expired();
    return this.#token!;
  }
  // A 401: the token is spent for the run. Never a plain return, which makes the SDK retry.
  async unauthorized(_token: string): Promise<void> {
    if (this.#fingerprint) ended.add(this.#fingerprint);
    throw this.#refusal ?? this.expired();
  }

  // Before the token goes anywhere: the pin is on the resource's origin and
  // the resource's own metadata names it (fetched without the token); then
  // whoami, asked with no session key so it starts no hosted session, names a
  // service, and the launcher's when GRAYBOARD_PRINCIPAL is set.
  private async verify(): Promise<void> {
    const { issuer, principal } = this.static;
    const pin = issuerEndpoint(issuer!)!;
    if (pin.origin !== new URL(this.resource).origin) throw new Refusal("identity", `Static mode refused: the pinned issuer ${issuer} isn't on ${new URL(this.resource).origin}, where this harness's server is set up`);
    let servers: string[];
    try { servers = (await resourceMetadata(this.resource, 10_000)).authorization_servers; }
    catch (error) {
      if (error instanceof ServerUnreachable) throw error;
      throw new Refusal("identity", `Static mode refused: ${this.resource}'s protected-resource metadata couldn't be checked against the pinned issuer (${(error as Error).message?.slice(0, 200) ?? "invalid"})`);
    }
    if (!servers.includes(issuer!)) throw new Refusal("identity", `Static mode refused: ${this.resource} doesn't name the pinned issuer ${issuer}`);
    const who = await this.whoami();
    if (who.kind !== "service") throw new Refusal("identity", "Static mode refused: the run token isn't a service's; static mode runs only as a service");
    if (principal !== undefined && who.principal !== principal) throw new Refusal("identity", `Static mode refused: the run token is service ${who.principal ?? "unknown"}'s, not ${principal}'s (${STATIC_PRINCIPAL})`);
  }
  private async whoami(): Promise<{ kind?: string; principal?: string }> {
    const token = this.#token!;
    const wire = new NativeWire({ url: this.resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: this.#config.clientId, version: this.#config.version } }, {
      token: async () => token,
      onUnauthorized: async () => this.unauthorized(token),
    }, AbortSignal.timeout(10_000));
    try {
      await wire.connect();
      const result = await wire.client.callTool({ name: "whoami", arguments: {} }, wire.options());
      const content = result.content as { type?: string; text?: string }[] | undefined;
      const value = result.structuredContent ?? (!result.isError && content?.length === 1 && content[0]?.type === "text" ? JSON.parse(content[0].text ?? "null") : undefined);
      // The server's outage, not its answer (#1250): retried like one.
      if (result.isError) {
        const refused = subscriberError(value, false);
        if (refused.code === "rate_limited" || refused.code === "internal_error") throw new ServerUnreachable(refused);
        throw new Refusal("identity", `Static mode refused: the server's whoami answered ${refused.code}`);
      }
      const fields = value as { principal_kind?: unknown; principal?: unknown } | undefined;
      const text = (v: unknown) => typeof v === "string" ? v : undefined;
      return { kind: text(fields?.principal_kind), principal: text(fields?.principal) };
    } catch (error) {
      // A 401 or a scope refusal at whoami ends the run like any other.
      if (signOutCause(error)) { if (this.#fingerprint) ended.add(this.#fingerprint); throw this.expired(); }
      throw error;
    } finally { await wire.close().catch(() => {}); }
  }

  // No store: a constant epoch, so RootDelivery's restart guard holds still.
  async read(): Promise<{ epoch: string }> { return { epoch: "static" }; }
  watch(): { dispose(): void } { return { dispose: () => {} }; }
  // The launcher holds the token; nothing here signs in or out.
  async login(): Promise<"signed in" | "current"> { throw new Refusal("auth", "static mode: the launcher supplies the run token"); }
  async logout(): Promise<void> { throw new Refusal("auth", "static mode: the launcher supplies the run token and revokes it"); }

  // The token's fingerprint stays out of the hash: a resumed session under the
  // next run's token keeps its remembered holds (the server keys nothing on it).
  private configuration(): Configuration {
    const { issuer, principal } = this.static;
    return { type: "remote", url: this.resource, issuer: issuer ?? "", clientID: SERVICE_CLIENT, scope: SCOPES, configHash: sha256(JSON.stringify(["static", this.resource, issuer ?? null, principal ?? null])) };
  }
  credential(): CredentialPort<Enrollment> {
    return {
      capture: async sessionID => { await this.token(); return { version: 2, sessionID, configuration: this.configuration() }; },
      check: async e => { if (e.configuration.configHash !== this.configuration().configHash) throw new Refusal("binding", `Grayboard sign-in changed in ${this.#config.harness}`); },
      watch: async () => ({ dispose: async () => {} }),
      token: async () => this.token(),
      unauthorized: async (_e, token) => this.unauthorized(token),
    };
  }
}
