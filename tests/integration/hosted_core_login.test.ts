// hosted-core's login (#430) against a real in-process server behind a
// counting proxy, which is also the issuer every client sees: a scripted
// browser through the real consent page (only the upstream Google exchange
// is stubbed), one grant for concurrent logins, exactly one refresh request
// across processes, a stopped refresh holder that nobody takes over, a lost
// refresh response that revokes instead of replaying, the refusals that need
// a new login, the 401 refresh, and logout through the credential port.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessExpired, Refusal, ServerOutdated } from "../../adapters/hosted-core/src/model.ts";
import { Login, type GrantStore, type LoginConfig } from "../../adapters/hosted-core/src/login.ts";
import { InsufficientScope, NativeWire } from "../../adapters/hosted-core/src/wire.ts";
import { writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";
import type { RecordStatus } from "../../adapters/hosted-core/src/diagnostics.ts";
import { startServer } from "../../src/server/app.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { GRAYBOARD_SESSION_META } from "../../src/server/oauth-config.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "../../src/server/rate_limit.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi";
const FIXTURE = join(import.meta.dir, "../../adapters/hosted-core/tests/fixtures/login-client.ts");

// ---- the proxy: the issuer's origin, counting refresh requests ----
type Hook = (req: IncomingMessage, body: Buffer, res: ServerResponse, forward: () => Promise<Response>) => Promise<void>;
let proxy: Server, issuer: string, target: string;
let refreshes = 0;
let onRefresh: Hook | undefined;
async function forward(req: IncomingMessage, body: Buffer): Promise<Response> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers.set(k, v);
  return fetch(new URL(req.url!, target), { method: req.method, headers, body: body.length ? body : undefined, redirect: "manual" });
}
async function relay(upstream: Response, res: ServerResponse) {
  const headers: Record<string, string | string[]> = {};
  upstream.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") headers[k] = v; });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(upstream.status, headers);
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}
function startProxy(): Promise<void> {
  proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    try {
      if (req.method === "POST" && req.url === "/oauth/token" && new URLSearchParams(body.toString()).get("grant_type") === "refresh_token") {
        refreshes++;
        if (onRefresh) return await onRefresh(req, body, res, () => forward(req, body));
      }
      await relay(await forward(req, body), res);
    } catch { res.destroy(); }
  });
  return new Promise(resolve => proxy.listen(0, "127.0.0.1", () => {
    const address = proxy.address();
    issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    resolve();
  }));
}

let app: ReturnType<typeof startServer>, dir: string, stateDir: string, resource: string;
const children: Bun.Subprocess[] = [];
const logins: Login[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-login-"));
  stateDir = join(dir, "state");
  refreshes = 0; onRefresh = undefined;
  await startProxy();
  app = startServer({ dbPath: join(dir, "db.sqlite"), blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "test-upstream", googleClientSecret: "", orgDomain: "example.com", publicUrl: issuer,
    messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES,
    hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, oauthClients: [],
  }, { hostname: "127.0.0.1", background: false, oauth: { exchangeGoogle: async () => ({ email: "alice@example.com", displayName: "Alice" }) } });
  target = `http://127.0.0.1:${app.server.port}`;
  resource = app.oauth.resource;
});
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGCONT"); child.kill("SIGKILL"); await child.exited; }
  logins.length = 0;
  await app.stop();
  app.db.close();
  await new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); });
  rmSync(dir, { recursive: true, force: true });
});

// ---- helpers ----
type Recorder = { presented: string[]; notices: string[]; diagnostics: Omit<RecordStatus, "time">[] };
function login(overrides: Partial<LoginConfig> = {}): Login & { seen: Recorder } {
  const seen: Recorder = { presented: [], notices: [], diagnostics: [] };
  const l = Object.assign(new Login({ resource, clientId: CLIENT, stateDir, harness: "pi", loginAction: "run /grayboard login",
    present: url => { seen.presented.push(url); }, notify: m => { seen.notices.push(m); }, diagnostic: r => { seen.diagnostics.push(r); }, ...overrides }), { seen });
  logins.push(l);
  return l;
}
// A store holding a real grant, its access token already expired locally so
// the next token() refreshes.
async function seed(options: { scopes?: string[]; access?: string; expiresIn?: number; clientId?: string; refresh?: string } = {}) {
  const issued = issueOAuth(app.repo, resource, "alice@example.com", options.scopes ?? ["grayboard:tools", "grayboard:delivery"], Date.now(), CLIENT);
  const store: GrantStore = { version: 1, resource, clientId: options.clientId ?? CLIENT, epoch: "seeded", issuer, scope: (options.scopes ?? ["grayboard:delivery", "grayboard:tools"]).join(" "),
    access: options.access ?? issued.token, accessExpiresAt: Date.now() + (options.expiresIn ?? -1_000), refresh: options.refresh ?? issued.refreshToken };
  await writeJsonAtomic(login({ clientId: store.clientId }).path, store);
  return { ...issued, store };
}
const audits = (action: string) => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM access_log WHERE action = ?").get(action)!.n;
const grants = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM oauth_grants WHERE json_extract(data, '$.clientId') = ?").get(CLIENT)!.n;
const liveGrants = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM oauth_grants WHERE json_extract(data, '$.clientId') = ? AND revoked_at IS NULL").get(CLIENT)!.n;

type Line = { started?: number; ok?: unknown; error?: string; message?: string; reason?: string; present?: string; notify?: string; diagnostic?: { code?: string }; done?: true };
// A login-client process; `next` waits for its next line matching `match`.
function spawn(command: "token" | "login" | "token-loop", arg?: string, clientId = CLIENT) {
  const child = Bun.spawn([process.execPath, FIXTURE, command, ...(arg ? [arg] : [])], { env: { ...process.env, GB_LOGIN_CONFIG: JSON.stringify({ resource, clientId, stateDir }) }, stdout: "pipe", stderr: "inherit" });
  children.push(child);
  const lines: Line[] = [];
  const read = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk);
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
    }
  })();
  return {
    child, lines,
    async next(match: (line: Line) => boolean, timeoutMs = 60_000): Promise<Line> {
      await until(() => lines.some(match), timeoutMs, "login-client line");
      return lines.find(match)!;
    },
    async finished(): Promise<Line[]> { await child.exited; await read; return lines; },
  };
}
const outcomes = (lines: Line[]) => lines.filter(l => "ok" in l || "error" in l);

// A browser with a cookie jar that walks the real authorize → (stubbed
// upstream) → consent → loopback callback round trip.
async function browse(authorizeUrl: string, decision: "approve" | "deny" = "approve") {
  const cookies = new Map<string, string>();
  const request = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) { const [k, v] = cookie.split(";")[0]!.split("="); cookies.set(k!, v!); }
    return res;
  };
  const begin = await request(authorizeUrl);
  expect(begin.status).toBe(303);
  const google = new URL(begin.headers.get("Location")!);
  expect(google.host).toBe("accounts.google.com");
  const callback = await request(`${issuer}/oauth/google/callback?` + new URLSearchParams({ code: "upstream-code", state: google.searchParams.get("state")!, iss: "https://accounts.google.com" }));
  expect(callback.status).toBe(303);
  const page = await (await request(callback.headers.get("Location")!)).text();
  expect(page).toContain("Authorize Grayboard for pi");
  const id = /name="request" value="([^"]+)"/.exec(page)![1]!, csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  const decided = await request(`${issuer}/oauth/consent`, { method: "POST", headers: { Origin: issuer }, body: new URLSearchParams({ request: id, csrf, decision }) });
  expect(decided.status).toBe(303);
  const loopback = decided.headers.get("Location")!;
  expect(loopback).toStartWith("http://127.0.0.1:");
  return (await fetch(loopback)).text();
}

// ---- login ----

test("login round trip: PKCE through the real consent page, a 0600 store, and a token for the server", async () => {
  const l = login({ present: async url => { await browse(url); } });
  await l.login();
  const s = (await l.read())!;
  expect(s).toMatchObject({ version: 1, resource, clientId: CLIENT, issuer, scope: "grayboard:delivery grayboard:tools" });
  expect(s.loginRequired).toBeUndefined();
  expect((await Bun.file(l.path).stat()).mode & 0o777).toBe(0o600);
  expect(grants()).toBe(1);
  const wire = new NativeWire({ url: resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT, version: "1.0.0" } }, { token: () => l.token() }, new AbortController().signal, "raw-root");
  await wire.connect();
  expect((await wire.callTool("whoami", {}, "raw-root")).isError).toBeFalsy();
  await wire.close();
  expect(refreshes).toBe(0);
});

test("a denied consent fails the login and writes nothing", async () => {
  const l = login({ present: async url => { expect(await browse(url, "deny")).toContain("did not complete"); } });
  await expect(l.login()).rejects.toThrow("sign-in was denied");
  expect(await l.read()).toBeUndefined();
  expect(grants()).toBe(0);
});

test("two concurrent login() calls in two processes create one grant", async () => {
  const a = spawn("login"), b = spawn("login");
  const presented = await Promise.race([a.next(l => !!l.present), b.next(l => !!l.present)]);
  const waiter = a.lines.some(l => l.present) ? b : a;
  expect((await waiter.next(l => !!l.notify)).notify).toBe("sign-in in progress in another pi session");
  await browse(presented.present!);
  const [ra, rb] = [outcomes(await a.finished()), outcomes(await b.finished())];
  expect(ra).toHaveLength(1); expect(rb).toHaveLength(1);
  expect(ra[0]!.ok).toBeString();
  expect(rb[0]!.ok).toBe(ra[0]!.ok!);
  expect([...a.lines, ...b.lines].filter(l => l.present)).toHaveLength(1);
  expect(grants()).toBe(1);
}, 30_000);

test("a server without the harness's built-in client is ServerOutdated, before any browser", async () => {
  const l = login({ clientId: "grayboard-future" });
  const error = await l.login().then(() => undefined, e => e);
  expect(error).toBeInstanceOf(ServerOutdated);
  expect((error as Error).message).toBe("this grayboard server predates the pi adapter; update the server");
  expect(l.seen.presented).toEqual([]);
});

// ---- refresh ----

test("two processes refreshing one expired store make exactly one refresh request and both end on the new token", async () => {
  const { store } = await seed();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  onRefresh = async (_req, _body, res, send) => { arrived(); await held; await relay(await send(), res); };
  const a = spawn("token");
  await reached;
  const b = spawn("token");
  await b.next(l => !!l.started);
  release();
  const [ra, rb] = [outcomes(await a.finished()), outcomes(await b.finished())];
  expect(refreshes).toBe(1);
  expect(ra[0]!.ok).toBeString();
  expect(ra[0]!.ok).not.toBe(store.access);
  expect(rb[0]!.ok).toBe(ra[0]!.ok!);
  const s = (await login().read())!;
  expect(s.access).toBe(ra[0]!.ok as string);
  expect(s.pending).toBeUndefined();
  expect(audits("oauth.refreshed")).toBe(1);
}, 30_000);

test("a refresh holder stopped after writing pending for 40 s: two other processes make zero refresh requests, nobody replays", async () => {
  await seed();
  let socket!: ServerResponse;
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  // The holder's request is held at the proxy and never answered.
  onRefresh = async (_req, _body, res) => { socket = res; arrived(); };
  const holder = spawn("token");
  await reached;
  expect((await login().read())!.pending).toBeNumber();
  holder.child.kill("SIGSTOP");
  const stoppedAt = performance.now();
  const others = [spawn("token-loop", "40000"), spawn("token-loop", "40000")];
  const results = await Promise.all(others.map(async o => outcomes(await o.finished())));
  expect(performance.now() - stoppedAt).toBeGreaterThanOrEqual(40_000);
  expect(refreshes).toBe(1);
  for (const r of results) {
    expect(r.length).toBeGreaterThanOrEqual(1);
    for (const line of r) expect(line).toMatchObject({ error: "RefreshInProgress", message: "token refresh in progress in another pi process" });
  }
  // Resumed, its request timeout has passed: the outcome is unknown, so it
  // revokes the token instead of sending it again.
  holder.child.kill("SIGCONT");
  const done = outcomes(await holder.finished());
  socket.destroy();
  expect(done).toEqual([{ error: "AccessExpired", message: "Signed out of grayboard in pi; run /grayboard login", reason: "refresh_outcome_unknown" }]);
  expect(holder.lines.find(l => l.diagnostic)?.diagnostic?.code).toBe("refresh_outcome_unknown");
  expect(refreshes).toBe(1);
  expect(audits("oauth.refresh_replay_revoked")).toBe(0);
  expect(audits("oauth.revoked")).toBe(1);
  expect(liveGrants()).toBe(0);
}, 120_000);

test("a dropped refresh response: login required, one oauth.revoked, no replay, and the next token() is AccessExpired", async () => {
  const { store } = await seed();
  // Forwarded, so the server spends the token; the response is lost.
  onRefresh = async (_req, _body, res, send) => { const upstream = await send(); await upstream.arrayBuffer(); res.destroy(); };
  const l = login();
  const error = await l.token().then(() => undefined, e => e);
  expect(error).toBeInstanceOf(AccessExpired);
  expect((error as AccessExpired).reason).toBe("refresh_outcome_unknown");
  expect(l.seen.diagnostics).toEqual([expect.objectContaining({ operation: "refresh", code: "refresh_outcome_unknown" })]);
  const s = (await l.read())!;
  expect(s.loginRequired).toEqual({ reason: "refresh_outcome_unknown" });
  expect(s.revoke).toBeUndefined();
  expect(s.refresh).toBeUndefined();
  expect(audits("oauth.refreshed")).toBe(1);
  expect(audits("oauth.revoked")).toBe(1);
  expect(audits("oauth.refresh_replay_revoked")).toBe(0);
  expect(liveGrants()).toBe(0);
  await expect(login().token()).rejects.toBeInstanceOf(AccessExpired);
  expect(refreshes).toBe(1);
  expect(s.epoch).toBe(store.epoch);
});

test("invalid_grant requires a login, with no retry", async () => {
  await seed({ refresh: "not-a-live-refresh-token-but-well-formed-0123456789abcdef" });
  const l = login();
  const error = await l.token().then(() => undefined, e => e);
  expect(error).toBeInstanceOf(AccessExpired);
  expect((error as AccessExpired).reason).toBe("login_required");
  expect((await l.read())!.loginRequired).toEqual({ reason: "invalid_grant" });
  await expect(l.token()).rejects.toBeInstanceOf(AccessExpired);
  expect(refreshes).toBe(1);
});

test("a token endpoint that doesn't know the client is ServerOutdated and spends nothing", async () => {
  const { store } = await seed({ clientId: "grayboard-future" });
  const l = login({ clientId: "grayboard-future" });
  await expect(l.token()).rejects.toBeInstanceOf(ServerOutdated);
  expect(await l.read()).toEqual(store);
  expect(refreshes).toBe(1);
});

test("403 insufficient_scope needs a new login, never a refresh", async () => {
  await seed({ scopes: ["grayboard:delivery"], expiresIn: 3_600_000 });
  const l = login();
  const credential = l.credential();
  const e = await credential.capture("raw-root");
  const wire = new NativeWire({ url: resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT, version: "1.0.0" } },
    { token: () => credential.token(e), onUnauthorized: async () => credential.unauthorized(e, "") }, new AbortController().signal, "raw-root");
  const error = await wire.connect().then(() => wire.callTool("whoami", {}, "raw-root")).then(() => undefined, err => err);
  await wire.close();
  expect(error).toBeInstanceOf(InsufficientScope);
  expect(refreshes).toBe(0);
});

test("a 401 runs one forced refresh, then the retried request succeeds", async () => {
  await seed({ access: "unknown-access-token-0123456789abcdefghijklmnopqr", expiresIn: 3_600_000 });
  const l = login();
  let current = "";
  const wire = new NativeWire({ url: resource, sessionKey: GRAYBOARD_SESSION_META, client: { name: CLIENT, version: "1.0.0" } },
    { token: async () => (current = await l.token()), onUnauthorized: async () => l.unauthorized(current) }, new AbortController().signal, "raw-root");
  await wire.connect();
  expect((await wire.callTool("whoami", {}, "raw-root")).isError).toBeFalsy();
  await wire.close();
  expect(refreshes).toBe(1);
  expect(current).toBe((await l.read())!.access!);
});

// ---- the credential port and logout ----

test("credential port: capture, check, token; logout revokes the grant, drifts every watcher and signs out", async () => {
  await seed({ expiresIn: 3_600_000 });
  const l = login();
  const credential = l.credential();
  const e = await credential.capture("raw-root");
  expect(e).toMatchObject({ version: 2, sessionID: "raw-root", configuration: { type: "remote", url: resource, issuer, clientID: CLIENT, scope: "grayboard:delivery grayboard:tools" } });
  await credential.check(e);
  expect(await credential.token(e)).toBe((await l.read())!.access!);
  let drifts = 0;
  const watch = await credential.watch(e, () => { drifts++; });
  try {
    await login().logout();
    await until(() => drifts > 0, 10_000, "drift after logout");
  } finally { await watch.dispose(); }
  const s = (await l.read())!;
  expect(s).toMatchObject({ loginRequired: { reason: "logged_out" } });
  expect(s.epoch).not.toBe("seeded");
  expect(s.revoke).toBeUndefined();
  await expect(credential.check(e)).rejects.toBeInstanceOf(Refusal);
  await expect(credential.capture("raw-root")).rejects.toBeInstanceOf(AccessExpired);
  expect(audits("oauth.revoked")).toBe(1);
  expect(liveGrants()).toBe(0);
  expect(refreshes).toBe(0);
});
