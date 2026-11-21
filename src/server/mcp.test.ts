import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { AppSession } from "../../tests/support/app_session.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError, createApplication } from "./application.ts";
import { createHostedMcp } from "./mcp.ts";
import { openDatabase, type Repo } from "./db.ts";
import { openRepo } from "./open_repo.ts";
import type { Config } from "./config.ts";
import type { AuthedUser } from "./auth.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { issueOAuth, rotateOAuth } from "../../tests/helpers/oauth.ts";
import { hashToken } from "./auth.ts";
import { OAUTH_TTL } from "./oauth-types.ts";
import { sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT } from "./oauth-config.ts";
import { DEFAULT_MCP_LIMITS, type McpLimits } from "./config.ts";
import { stubAuthRead } from "../../tests/support/auth_stub.ts";
import { isTx, type Read } from "./store/tx.ts";
import { sessionEndPort } from "./session_end.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";
import { until } from "../../tests/support/until.ts";
import { TEST_BACKEND } from "../../tests/support/server.ts";
import { drained, execOn, pgText, row, rows } from "../../tests/support/repo_sql.ts";
const meta = { "ai.opencode/sessionID": "test-root" };
const issuedOAuth = (repo: Parameters<typeof issueOAuth>[0], resource: string, email = "alice@example.com", scopes = ["grayboard:tools"]) => issueOAuth(repo, resource, email, scopes, Date.now(), OPENCODE_CLIENT);

// The fixture's store, on GRAYBOARD_TEST_BACKEND's backend (#1491): SQLite by default, a Postgres database of its own
// (cloned from the test template, dropped by close) under pg. `db` is the SQLite connection, for the tests that are
// SQLite by nature (testSqlite); every other raw read goes through repo_sql's row/rows, which take either backend.
type Database = ReturnType<typeof openDatabase>["db"];
// `otherCommit`: a write committed on a connection of its own, outside the Repo (another process's, or another pod's).
type Store = { repo: Repo; readonly db: Database; config: Config; otherCommit(sql: string, ...params: unknown[]): Promise<void>; close(): Promise<void> };
let store: Store;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedMcp>;
let user: AuthedUser;
let token: string;
let oauth: ReturnType<typeof createOAuthServer>;
let blobDir: string;
const clients: Client[] = [];
beforeEach(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "gb-mcp-"));
  store = await openStore(TEST_BACKEND === "pg" ? undefined : scratchDbPath());
  application = createApplication(store.repo, { helloLimit: { burst: 10000, perSec: 10000 }, hostedRequestLimit: { burst: 10000, perSec: 10000 }, hostedSubscriberLimit: { burst: 10000, perSec: 10000 } });
  oauth = createOAuthServer(store.repo, store.config);
  hosted = createHostedMcp(application, oauth, { trustedOrigin: "https://grayboard.example.com:443" });
  const issued = await issuedOAuth(store.repo, oauth.resource);
  token = issued.token;
  user = issued.authed;
  const principal = await oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.bind(principal, sessionContext(principal, meta), { name: "be", create: true, where: "tools" });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await hosted.close();
  expect(hosted.activeContexts).toBe(0);
  expect(hosted.activeGetStreams).toBe(0);
  expect(hosted.activeStreams).toBe(0);
  expect(hosted.activeBusListeners).toBe(0);
  expect(hosted.activeWatches).toBe(0);
  expect(hosted.activeLegacySessions).toBe(0);
  expect(hosted.dormantLegacySessions).toBe(0);
  expect(hosted.activePosts).toBe(0);
  oauth.close();
  await application.stopExpiry();
  await Bun.sleep(0);
  await store.close();
  rmSync(blobDir, { recursive: true, force: true });
});

const fixtureConfig = (dbStore: Config["store"]): Config => ({ store: dbStore, blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com:443", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES });

// The fixture's store: SQLite on `path`, or (no path) a fresh Postgres database through openRepo, as the server opens it.
async function openStore(path: string | undefined): Promise<Store> {
  if (path !== undefined) {
    const { db, repo } = openDatabase(path, { blobDir, sessionEnd: sessionEndPort("team") });
    return {
      repo, db, config: fixtureConfig({ kind: "sqlite", path }),
      async otherCommit(sql, ...params) {
        const { Database } = await import("bun:sqlite");
        const other = new Database(path);
        try { other.run(sql, params as never[]); } finally { other.close(); }
      },
      async close() { db.close(); },
    };
  }
  const { pgDatabase } = await import("../../tests/support/pg.ts");
  const pg = await pgDatabase({ max: 1 });
  const config = fixtureConfig({ kind: "postgres", url: pg.url });
  let repo: Repo;
  try { repo = await openRepo(config, { pool: { applicationName: "gb-test", max: 4 } }); }
  catch (error) { await pg[Symbol.asyncDispose](); throw error; }
  return {
    repo, config,
    async otherCommit(sql, ...params) { await pg.sql.unsafe(pgText(sql), params); },
    get db(): Database { throw new Error("store.db: the fixture is on Postgres; the test is SQLite only (testSqlite)"); },
    async close() { try { await repo.close(); } finally { await pg[Symbol.asyncDispose](); } },
  };
}

// #1491: CI's test-pg job lists this file; the fixture must follow GRAYBOARD_TEST_BACKEND, or that run is SQLite again.
test("the fixture's store is GRAYBOARD_TEST_BACKEND's", async () => {
  expect(store.config.store.kind).toBe(TEST_BACKEND === "pg" ? "postgres" : "sqlite");
  const version = TEST_BACKEND === "pg" ? "SELECT version() AS v" : "SELECT 'SQLite ' || sqlite_version() AS v";
  expect((await row<{ v: string }>(store.repo, version))!.v).toStartWith(TEST_BACKEND === "pg" ? "PostgreSQL" : "SQLite");
});

test("resource authorization does not sweep unrelated hosted roots", async () => {
  const client = await connect();
  await client.callTool({ name: "board_create", arguments: { name: "general", purpose: "resource fixture" } });
  const sweep = spyOn(hosted.sessions, "sweep");
  try {
    const resource = await client.readResource({ uri: "grayboard://boards/general" });
    expect(resource.contents).toHaveLength(1);
    expect(sweep).not.toHaveBeenCalled();
  } finally { sweep.mockRestore(); }
});

test("legacy identity headers cannot select or create names; explicit bind retains closest-name refusal", async () => {
  const client = await connect("2026-07-28", undefined, new Headers({ "X-Grayboard-Identity": "bee" }));
  const identity = await client.callTool({ name: "whoami", arguments: {} });
  expect(identity.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/"primary":\s*"alice@example.com\/be"/) })]);
  const refused = await client.callTool({ name: "bind", arguments: { name: "bee" } });
  expect(refused.isError).toBe(true);
  expect(refused.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/"known":\s*\[\s*"be"\s*\]/) })]);
  expect(await store.repo.aliases.find(store.repo.read, `${user.user_email}/bee`)).toBeUndefined();
  expect(hosted.activeContexts).toBe(0);
});

async function connect(version = "2026-07-28", intercept?: (response: Response, request: Request) => Promise<void>, headers?: Headers, observeRequest?: (request: Request) => void, routing: Record<string, unknown> = meta) {
  const client = new Client({ name: "unit", version: "1" }, {
    supportedProtocolVersions: [version], versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
  });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      let request = new Request(input, init);
      if (request.method === "POST" && request.body) {
        const body = await request.json() as { params?: Record<string, unknown> };
        body.params = { ...body.params, _meta: { ...((body.params?._meta ?? {}) as object), ...routing } };
        request = new Request(request, { body: JSON.stringify(body) });
      }
      headers?.forEach((value, key) => request.headers.set(key, value));
      observeRequest?.(request);
      const response = await hosted.fetch(request);
      await intercept?.(response, request);
      return response;
    },
  }));
  return client;
}

// Subscriptions and outbox rows: what a consuming read would change.
const deliveryState = async () => ({
  subs: await rows(store.repo, "SELECT board, handle, mode, cursor FROM subscriptions ORDER BY board, handle"),
  outbox: await rows(store.repo, "SELECT handle, post_id, delivered_at FROM outbox ORDER BY handle, post_id"),
});
// access_log rows of `action` in write order, once every write queued before the read has committed: a posted audit
// row runs at once on SQLite's idle queue but is always queued on Postgres (repo_sql.ts drained).
async function auditRows(action: string): Promise<{ actor: string | null; target: string | null; detail: string }[]> {
  await drained(store.repo);
  return rows(store.repo, "SELECT actor, target, detail FROM access_log WHERE action = ? ORDER BY id", action);
}
const closedReasons = async () => (await auditRows("hosted.stream_closed")).map(r => JSON.parse(r.detail).reason as string);

// An owner's general and team-only boards, each with a post and a board
// claim, and an unbound reader: the owner's own principal when mapped, an
// unrelated user's otherwise.
async function unboundReader(mapped: boolean) {
  const owner = await connect();
  expect((await owner.callTool({ name: "board_create", arguments: { name: "general", purpose: "visible catalog" } })).isError).not.toBe(true);
  expect((await owner.callTool({ name: "board_post", arguments: { board: "general", body: "open hello" } })).isError).not.toBe(true);
  await seed(store.repo, async (tx) => {
    const team = await store.repo.teams.create(tx, "private", user.user_id);
    await store.repo.teams.addMember(tx, team.id, user.user_id);
  });
  expect((await owner.callTool({ name: "board_create", arguments: { name: "secret", purpose: "team only", team: "private" } })).isError).not.toBe(true);
  expect((await owner.callTool({ name: "board_post", arguments: { board: "secret", body: "team hello" } })).isError).not.toBe(true);
  for (const board of ["general", "secret"]) expect((await owner.callTool({ name: "claim_take", arguments: { key: `lane:${board}`, board } })).isError).not.toBe(true);
  const access = mapped ? token : (await issueOAuth(store.repo, oauth.resource, "reader@example.com")).token;
  const client = new Client({ name: "unbound-reader", version: "1" }, { supportedProtocolVersions: ["2026-07-28"], versionNegotiation: { mode: { pin: "2026-07-28" } } });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${access}` } },
    fetch: (input, init) => hosted.fetch(new Request(input, init)),
  }));
  return client;
}

for (const mapped of [true, false]) test(`unbound native resource catalog lists and reads a visible board, mapped=${mapped}`, async () => {
  const client = await unboundReader(mapped);
  const before = (await deliveryState());
  const resources = await client.listResources();
  expect(resources.resources.some(resource => resource.uri === "grayboard://boards/general")).toBe(true);
  expect((await client.readResource({ uri: "grayboard://boards/general" })).contents.length).toBeGreaterThan(0);
  expect((await deliveryState())).toEqual(before);
});

// #410: tool reads with no session key judge visibility by the user's
// principal (own and team boards, never another team's) and change nothing.
for (const mapped of [true, false]) test(`#410: unbound tool reads judge visibility by principal and change nothing, mapped=${mapped}`, async () => {
  const client = await unboundReader(mapped);
  const before = (await deliveryState());
  const text = (r: { isError?: boolean; content: unknown }) => {
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };
  const listed = text(await client.callTool({ name: "board_list", arguments: {} })) as { name: string; mode: unknown; unread: number }[];
  const names = listed.map(b => b.name);
  expect(names).toContain("general");
  if (mapped) expect(names).toContain("secret");
  else expect(names).not.toContain("secret");
  for (const b of listed) expect(b).toMatchObject({ mode: null, unread: 0 });
  expect(text(await client.callTool({ name: "board_read", arguments: { board: "general" } })).posts.map((p: { body: string }) => p.body)).toEqual(["open hello", "[claim] lane:general"]);
  const secret = await client.callTool({ name: "board_read", arguments: { board: "secret" } });
  if (mapped) expect(text(secret).posts.map((p: { body: string }) => p.body)).toEqual(["team hello", "[claim] lane:secret"]);
  else expect(secret.isError).toBe(true);
  const claims = text(await client.callTool({ name: "claim_list", arguments: { prefix: "lane:" } })) as { key: string; board: string | null }[];
  expect(claims.map(c => [c.key, c.board])).toEqual([["lane:general", "general"], ["lane:secret", mapped ? "secret" : null]]);
  expect(text(await client.callTool({ name: "peer_list", arguments: { board: "general" } }))).toHaveProperty("peers");
  expect((await deliveryState())).toEqual(before);
  expect((await client.callTool({ name: "board_create", arguments: { name: "refused", purpose: "unbound" } })).isError).toBe(true);
  expect((await client.callTool({ name: "bind", arguments: { name: "refused", create: true } })).isError).toBe(true);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: tools-only contexts preserve live owner and its status`, async () => {
  const owner = new AppSession(application, store.repo, user, "fe");
  await owner.connect();
  await seed(store.repo, tx => application.hostedPlace(tx, owner.id, "owner")); // the place hello's `where` set
  const events = owner.events;
  await owner.call("peer_status", { text: "working" });
  const client = await connect(version);
  for (let n = 0; n < 10; n++) {
    expect((await client.callTool({ name: "dm_send", arguments: { to: "fe", body: `hello ${n}` } })).isError).not.toBe(true);
  }
  expect(events).toHaveLength(10);
  const peers = await owner.call<{ peers: unknown[] }>("peer_list", {});
  expect(peers.peers).toContainEqual(expect.objectContaining({ handle: "alice@example.com/fe", online: true, status: "working", where: "owner" }));
  expect(await store.repo.cursors.directFor(store.repo.read, owner.session.identityFull)).toBe(0);
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  await expect(new AppSession(application, store.repo, user, "fe").connect()).rejects.toMatchObject({ code: "alias_held" }); // #284: was identity_in_use
});

test("Origin policy precedes authentication and context creation on every HTTP method", async () => {
  let selections = 0;
  const select = hosted.sessions.snapshot;
  hosted.sessions.snapshot = async (...args) => { selections++; return select(...args); };
  const forbidden = [
    "https://foreign.example.com", "http://grayboard.example.com", "null", "", "not an origin",
    "https://grayboard.example.com/", "https://grayboard.example.com/path", "https://grayboard.example.com?query",
    "https://grayboard.example.com#fragment", "https://user@grayboard.example.com",
    "https://grayboard.example.com https://foreign.example.com", "https://grayboard.example.com,https://foreign.example.com",
    "https://grayboard.example.com\\\\path", "https://%67rayboard.example.com", "HTTPS://grayboard.example.com",
  ];
  for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT", "PATCH", "HEAD"]) {
    for (const origin of forbidden) {
      for (const authorization of [undefined, `Bearer ${token}`]) {
        const response = await hosted.fetch(new Request("http://localhost/mcp", {
          method, headers: { Origin: origin, ...(authorization ? { Authorization: authorization } : {}) },
        }));
        expect(response.status).toBe(403);
      }
    }
    for (const origin of [undefined, "https://grayboard.example.com", "https://grayboard.example.com:443"]) {
      const response = await hosted.fetch(new Request("http://localhost/mcp", { method, headers: origin === undefined ? {} : { Origin: origin } }));
      expect(response.status).toBe(401);
    }
  }
  expect(selections).toBe(0);
  expect(await store.repo.aliases.find(store.repo.read, `${user.user_email}/refused`)).toBeUndefined();
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

test("legacy SSE context survives fetch return until SDK reader cancellation", async () => {
  let cancelled = false;
  await expect(connect("2025-11-25", async response => {
    if (!cancelled && response.headers.get("content-type")?.includes("text/event-stream")) {
      cancelled = true;
      expect(hosted.activeContexts).toBe(1);
      await response.body!.cancel();
      expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
      throw new Error("test cancelled response");
    }
  })).rejects.toThrow();
  expect(cancelled).toBe(true);
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

test("shutdown closes outstanding legacy SSE products and refuses new contexts", async () => {
  await connect("2025-11-25");
  await untilHosted(() => hosted.activeGetStreams === 1);
  expect(hosted.activeContexts).toBe(1);
  await hosted.close();
  expect(hosted.activeGetStreams).toBe(0);
  expect(hosted.activeContexts).toBe(0);
  expect(hosted.activeLegacySessions).toBe(0);
  expect(hosted.activeStreams).toBe(0);
  expect((await hosted.fetch(new Request("http://localhost/mcp"))).status).toBe(503);
});

test("shutdown racing the factory cannot leave a selected context behind", async () => {
  const select = hosted.sessions.snapshot;
  let selected!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { selected = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  hosted.sessions.snapshot = async (...args) => {
    const result = await select(...args);
    selected();
    await gate;
    return result;
  };
  const pending = connect();
  await ready;
  await hosted.close();
  release();
  await expect(pending).rejects.toThrow();
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: only typed admission refusals bypass factory error redaction`, async () => {
  let last!: { status: number; retryAfter: string | null; body: string };
  const client = await connect(version, async response => {
    last = { status: response.status, retryAfter: response.headers.get("Retry-After"), body: await response.clone().text() };
  });
  const select = hosted.sessions.snapshot;
  const secret = "SELECT token FROM /private/database.sqlite alice@example.com";
  for (const error of [new Error(secret), new ApplicationError("internal", secret), { code: "rate_limited", message: secret, extra: { retry_after_ms: 1250 } }, ...[0, -1, NaN, Infinity].map(retry_after_ms => new ApplicationError("rate_limited", secret, { retry_after_ms }))]) {
    hosted.sessions.snapshot = async () => { throw error; };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(500);
    expect(last.retryAfter).toBeNull();
    expect(last.body).not.toContain(secret);
    expect(last.body).not.toContain("retry_after_ms");
  }
  hosted.sessions.snapshot = async () => { throw new ApplicationError("rate_limited", secret, { retry_after_ms: 1250 }); };
  await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
  expect(last.status).toBe(429);
  expect(last.retryAfter).toBe("2");
  expect(JSON.parse(last.body)).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, data: { code: "rate_limited", retry_after_ms: 1250 } } });
  expect(last.body).not.toContain(secret);
  hosted.sessions.snapshot = select;
  expect((await client.callTool({ name: "board_list", arguments: {} })).isError).not.toBe(true);
  expect(last.status).toBe(200);
  expect(last.retryAfter).toBeNull();
  let selections = 0;
  hosted.sessions.snapshot = async (...args) => {
    const n = ++selections;
    await Promise.resolve();
    if (n === 1) throw new ApplicationError("rate_limited", secret, { retry_after_ms: 1250 });
    return select(...args);
  };
  const results = await Promise.allSettled([client.callTool({ name: "board_list", arguments: {} }), client.callTool({ name: "board_list", arguments: {} })]);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(selections).toBe(2);
  hosted.sessions.snapshot = select;
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: native delegation uses the bound root and retains own-user targeting`, async () => {
  const owner = new AppSession(application, store.repo, user, "launcher", { launcher: true });
  await owner.connect();
  const foreign = (await issuedOAuth(store.repo, oauth.resource, "bob@example.com")).authed;
  const other = new AppSession(application, store.repo, foreign, "outsider", { launcher: true });
  await other.connect();
  try {
    const client = await connect(version);
    expect((await client.listTools()).tools.some(t => t.name === "delegate")).toBe(true);
    const refused = await client.callTool({ name: "delegate", arguments: { persona: "researcher", task: "inspect the invariant", to: "bob@example.com/outsider" } });
    expect(refused.isError).toBe(true);
    expect(await other.history()).toEqual([]);
    const result = await client.callTool({ name: "delegate", arguments: { persona: "researcher", task: "inspect the invariant", to: "launcher" } });
    expect(result.isError).not.toBe(true);
    const messages = await owner.history();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender).toBe("alice@example.com/be");
    expect(messages[0]!.body).toContain('"persona": "researcher"');
    expect(await auditRows("delegation.requested")).toHaveLength(1);
  } finally { owner.close(); other.close(); }
});

test("hosted bind does not inherit a previous application-level launcher's opt-in", async () => {
  const prior = new AppSession(application, store.repo, user, "launcher", { launcher: true });
  await prior.connect();
  // No grace since #282: close() leaves the hold, so the prior session releases the name by unbinding it.
  await prior.unbind("alice@example.com/launcher");
  prior.close();
  const client = await connect();
  expect((await client.callTool({ name: "bind", arguments: { name: "launcher" } })).isError).not.toBe(true);
  expect(await row(store.repo, "SELECT i.launcher FROM ids i JOIN alias_holds h ON h.id = i.id WHERE h.address = ?", "alice@example.com/launcher")).toEqual({ launcher: 0 });
  expect(await row(store.repo, "SELECT launcher FROM ids WHERE id = ?", prior.id)).toEqual({ launcher: 1 });
});

test("internal operation failures are redacted, including paths and SQL", async () => {
  const client = await connect();
  const original = application.call;
  application.call = () => { throw new Error("SELECT token FROM /private/database.sqlite secret"); };
  try {
    const result = await client.callTool({ name: "board_list", arguments: {} });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
  } finally { application.call = original; }
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: unexpected hosted repo failures log once without credentials or tool arguments`, async () => {
  const client = await connect(version);
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const original = store.repo.messages.insert;
  const secret = `Bearer ${token} client_secret=hidden https://user:password@example.com/auth?code=hidden`;
  const multiline = new Error(`${secret}\n    at query (/private/server/${token}.ts:12:34)\n    at query (/private/server/mcp.ts:12:34)`);
  const forged = new Error(secret, { cause: new Error(secret) });
  forged.stack = `Error: failure\n    at query (/private/server/${token}.js:12:34)\n    at query (/private/server/mcp.ts:12:34)\n    at auth (https://example.com/${token}.ts?token=${token}:12:34)`;
  (forged.cause as Error).stack = `Error: cause\n    at query (/private/server/${token}.ts:12:34)`;
  const cycle = new Error(secret);
  cycle.cause = cycle;
  const getters = new Error("untrusted properties");
  let reads = 0;
  for (const key of ["message", "stack", "cause"]) Object.defineProperty(getters, key, { get() { reads++; throw new Error(secret); } });
  const named = Object.assign(new Error(secret), { name: `${token}-Error`, code: `E${token}` });
  const sqlite = Object.assign(new Error(secret), { name: "SQLiteError", code: "SQLITE_BUSY" });
  const classes = new Map<Error, string>([[named, '"class":"[unrecognized]"}'], [sqlite, '"class":"SQLiteError","code":"SQLITE_BUSY"}']]);
  try {
    for (const error of [multiline, forged, cycle, getters, named, sqlite]) {
      logs.mockClear();
      store.repo.messages.insert = () => { throw error; };
      const result = await client.callTool({ name: "dm_send", arguments: { to: "be", body: "private tool body" } });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "error: internal error" }] });
      expect(logs).toHaveBeenCalledTimes(1);
      const line = String(logs.mock.calls[0]![0]);
      expect(line).toContain('"tool":"dm_send"');
      expect(line).toContain('"principal":');
      expect(line).toContain('"session":');
      expect(line).toContain('"source":"src/server/mcp.ts","operation":"tool","category":"unexpected"');
      expect(line).toContain(classes.get(error) ?? '"class":"Error"}');
      expect(line.length).toBeLessThan(1024);
      for (const hidden of [token, "hidden", "password", "private tool body", "client_secret", "/auth?", "12:34"]) expect(line).not.toContain(hidden);
      expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
    }
    expect(reads).toBe(0);
    await client.close();
    expect(hosted.activeContexts).toBe(0);
  } finally { store.repo.messages.insert = original; logs.mockRestore(); }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: factory construction failures are generic and release the stable context`, async () => {
  const logs = spyOn(console, "error").mockImplementation(() => {});
  let reads = 0;
  const hostile = new Error("opaque");
  for (const key of ["message", "stack", "cause"]) Object.defineProperty(hostile, key, { get() { reads++; throw new Error(token); } });
  const fault = spyOn(McpServer.prototype, "registerTool").mockImplementation(() => { throw hostile; });
  try {
    await expect(connect(version)).rejects.toThrow();
    const failures = logs.mock.calls.filter(call => String(call[0]).startsWith("[grayboard] hosted MCP failed:"));
    expect(failures).toHaveLength(1);
    expect(String(failures[0]![0])).toContain(`"operation":"${version === "2026-07-28" ? "factory" : "fetch"}"`);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
    expect(reads).toBe(0);
    expect(hosted.activeContexts).toBe(0);
  } finally { fault.mockRestore(); logs.mockRestore(); }
});

for (const version of ["2026-07-28", "2025-11-25"]) test(`${version}: selection errors log once, expected refusals do not log, and lost authentication returns 401`, async () => {
  let last!: Response;
  // POSTs only: a legacy client's GET stream may answer after a later POST (#807 P3 A6e2).
  const client = await connect(version, async (response, request) => { if (request.method === "POST") last = response.clone(); });
  // The legacy client opens its GET stream after initialize; it must select before the faulty snapshot goes in (#807 P3 A7c).
  if (version !== "2026-07-28") await untilHosted(() => hosted.activeGetStreams === 1);
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const original = hosted.sessions.snapshot;
  try {
    hosted.sessions.snapshot = async () => { throw new Error(`token=${token}`); };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(500);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
    logs.mockClear();
    hosted.sessions.snapshot = async () => { throw new ApplicationError("unauthenticated", `revoked ${token}`); };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(401);
    expect(await last.text()).not.toContain(token);
    expect(logs).not.toHaveBeenCalled();
    hosted.sessions.snapshot = async () => { throw new ApplicationError("rate_limited", "retry", { retry_after_ms: 1000 }); };
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(429);
    expect(logs).not.toHaveBeenCalled();
  } finally { hosted.sessions.snapshot = original; logs.mockRestore(); }
});

test("Origin and identity diagnostics are address-limited and omit URL secrets", async () => {
  const client = await connect();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let n = 0; n < 5; n++) {
      const response = await hosted.fetch(new Request("http://localhost/mcp", { headers: { Origin: "https://user:password@foreign.example.com/path?token=hidden", Authorization: `Bearer ${token}` } }), "192.0.2.1");
      expect(response.status).toBe(403);
    }
    expect(logs).toHaveBeenCalledTimes(1);
    const response = await client.callTool({ name: "bind", arguments: { name: "human" } });
    expect(response.isError).toBe(true);
    expect(logs).toHaveBeenCalledTimes(2);
    const text = JSON.stringify(logs.mock.calls);
    expect(text).toContain("https://foreign.example.com");
    expect(text).toContain("https://grayboard.example.com");
    for (const secret of [token, "password", "hidden", "?token"]) expect(text).not.toContain(secret);
  } finally { logs.mockRestore(); }
});

for (const revoked of [false, true]) test(`authentication lost between HTTP preflight and factory (${revoked ? "revoked" : "disabled"}) returns 401 without an unexpected log`, async () => {
  let last!: Response;
  const client = await connect("2026-07-28", async response => { last = response.clone(); });
  const original = application.admitHosted, { snapshot } = hosted.sessions;
  const logs = spyOn(console, "error").mockImplementation(() => {});
  // Lost right after admission, before the factory's selection reads it. The revoke and the disable answer with a
  // promise (#807 P3 A6b), so they run in a queued write the selection awaits, not a synchronous hook's seedSync.
  let admitted = false;
  application.admitHosted = (...args) => {
    original(...args);
    admitted = true;
  };
  hosted.sessions.snapshot = async (...args) => {
    if (admitted) {
      admitted = false;
      await seed(store.repo, async tx => {
        if (revoked) await store.repo.sessions.revokeAllForUser(tx, user.user_id);
        else await store.repo.users.setDisabled(tx, user.user_id, true);
      });
    }
    return snapshot.apply(hosted.sessions, args);
  };
  try {
    await expect(client.callTool({ name: "board_list", arguments: {} })).rejects.toThrow();
    expect(last.status).toBe(401);
    expect(last.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(await last.json()).toMatchObject({ error: "invalid_token" });
    expect(logs).not.toHaveBeenCalled();
    expect(hosted.activeContexts).toBe(0);
  } finally { application.admitHosted = original; hosted.sessions.snapshot = snapshot; logs.mockRestore(); }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) for (const status of [401, 403]) test(`${version}: explicit factory ${status} response is preserved unchanged`, async () => {
  let response: Response | undefined;
  const client = await connect(version, async (r, request) => { if (request.method === "POST") response = r; });
  // The legacy client's background GET stream authenticates too; it must be done before the counting stub goes in.
  if (version !== "2026-07-28") await untilHosted(() => hosted.activeGetStreams === 1);
  const credential = status === 401 ? "invalid" : (await issuedOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:delivery"])).token;
  const refusal = await oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${credential}` } }));
  if (!(refusal instanceof Response)) throw new Error("expected fixture OAuth refusal");
  expect(refusal.status).toBe(status);
  const original = oauth.authenticate;
  let checks = 0;
  oauth.authenticate = async (...args) => ++checks === 2 ? refusal : original(...args);
  try {
    await client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } }).catch(() => undefined);
    expect(response).toBe(refusal);
    expect(response!.headers.get("WWW-Authenticate")).toContain(`scope="${status === 401 ? "grayboard:delivery grayboard:tools" : "grayboard:tools"}", error="${status === 401 ? "invalid_token" : "insufficient_scope"}"`);
    expect(response!.headers.get("WWW-Authenticate")).toContain(oauth.resourceMetadata);
    expect(checks).toBe(2);
    expect(await row(store.repo, "SELECT name FROM boards WHERE name = 'blocked'")).toBeNull();
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { oauth.authenticate = original; }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: revocation during identity selection preserves the precommit OAuth challenge`, async () => {
  let response: Response | undefined;
  const client = await connect(version, async r => { response = r; });
  // The legacy client opens its GET stream after initialize; it must select before the held snapshot goes in, or its
  // selection, not the POST's, can be the one held (#807 P3 A7c; seen on Postgres, #1491).
  if (version !== "2026-07-28") await untilHosted(() => hosted.activeGetStreams === 1);
  const original = hosted.sessions.snapshot;
  let selected!: () => void, release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  hosted.sessions.snapshot = async (...args) => {
    const result = await original(...args);
    selected();
    await barrier;
    return result;
  };
  try {
    const pending = client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } }).catch(e => e);
    await selection;
    await seed(store.repo, tx => store.repo.sessions.revokeAllForUser(tx, user.user_id));
    release();
    await pending;
    expect(response!.status).toBe(401);
    expect(response!.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${oauth.resourceMetadata}", scope="grayboard:delivery grayboard:tools", error="invalid_token"`);
    expect(await row(store.repo, "SELECT name FROM boards WHERE name = 'blocked'")).toBeNull();
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { release(); hosted.sessions.snapshot = original; }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) for (const stop of ["abort", "close"] as const) test(`${version}: ${stop} during selection is not an OAuth refusal`, async () => {
  const original = hosted.sessions.snapshot;
  let selected!: () => void, release!: () => void;
  const selection = new Promise<void>(resolve => { selected = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  hosted.sessions.snapshot = async (...args) => {
    const result = await original(...args);
    selected();
    await barrier;
    return result;
  };
  const abort = new AbortController();
  const params = { name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" }, _meta: { ...meta }, ...(version === "2026-07-28" ? { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "barrier", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) };
  try {
    const pending = hosted.fetch(new Request("http://localhost/mcp", { method: "POST", signal: abort.signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": version, ...(version === "2026-07-28" ? { "Mcp-Method": "tools/call", "Mcp-Name": "board_create" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) }));
    await selection;
    await seed(store.repo, tx => store.repo.sessions.revokeAllForUser(tx, user.user_id));
    if (stop === "abort") abort.abort(); else await hosted.close();
    release();
    const response = await pending;
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    await response.arrayBuffer();
    expect(await row(store.repo, "SELECT name FROM boards WHERE name = 'blocked'")).toBeNull();
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { release(); hosted.sessions.snapshot = original; }
});

test("actual access revocation between factory and dispatch prevents mutation", async () => {
  const client = await connect();
  const original = oauth.isAuthorized;
  let checks = 0;
  // The first check passes, then the revoke commits before it returns (#807 P3 C10d2-a: the revoke's body awaits its
  // hosted ends, so it no longer commits within the few microtasks the check took to come back).
  const revokeOnFirst = async (principal: OAuthPrincipal) => {
    if (++checks === 1) await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, principal.accessHash, principal.clientId, Date.now()));
  };
  // Selection and dispatch both check through the async form (#807 P3 A7d2b): either may be first.
  oauth.isAuthorized = async principal => { const valid = await original(principal); await revokeOnFirst(principal); return valid; };
  try {
    await expect(client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } })).rejects.toThrow("invalid_token");
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(await row(store.repo, "SELECT name FROM boards WHERE name = 'blocked'")).toBeNull();
  } finally { oauth.isAuthorized = original; }
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) test(`${version}: factory and dispatch persistence errors are redacted`, async () => {
  const client = await connect(version);
  // A legacy client opens its GET stream in the background; its authorization must not take the stage's throw.
  if (version !== "2026-07-28") await untilHosted(() => hosted.activeGetStreams === 1);
  for (const stage of [2, 3, 4]) {
    let checks = 0;
    const restoreAccess = stubAuthRead(store.repo, "findActiveAccess", original => (...args) => {
      if (++checks === stage) throw new Error("SELECT secret FROM /private/oauth.sqlite");
      return original(...args);
    });
    try {
      let result: unknown;
      try { result = await client.callTool({ name: "board_create", arguments: { name: "blocked", purpose: "must not mutate" } }); }
      catch (e) { result = String(e); }
      const encoded = JSON.stringify(result);
      expect(encoded).not.toMatch(/SELECT|private|sqlite|secret/);
      expect(encoded).toMatch(/internal|Internal/);
      expect(checks).toBe(stage);
      expect(await row(store.repo, "SELECT name FROM boards WHERE name = 'blocked'")).toBeNull();
      expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
    } finally { restoreAccess(); }
  }
});

for (const version of ["2025-11-25", "2025-06-18"]) test(`${version}: concurrent refreshed exchanges keep their own access after reversed awaits`, async () => {
  const grant = await issuedOAuth(store.repo, oauth.resource);
  const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
  const client = await connect(version, undefined, headers);
  await Bun.sleep(0);
  let refreshToken = grant.refreshToken;
  async function rotate() {
    const { access, refresh, status } = await rotateOAuth(store.repo, grant, refreshToken);
    expect(status).toBe("ok");
    refreshToken = refresh;
    return access;
  }
  const firstAccess = await rotate(), secondAccess = await rotate();
  await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, grant.tokens.accessHash, grant.binding.clientId, Date.now()));
  const select = hosted.sessions.snapshot;
  const releases: Array<() => void> = [];
  async function selected(count: number) {
    const deadline = performance.now() + 1000;
    while (releases.length < count && performance.now() < deadline) await Bun.sleep(1);
    expect(releases.length).toBe(count);
  }
  hosted.sessions.snapshot = async (...args) => {
    const selected = await select(...args);
    await new Promise<void>(resolve => releases.push(resolve));
    return selected;
  };
  try {
    headers.set("Authorization", `Bearer ${firstAccess}`);
    const first = client.callTool({ name: "whoami", arguments: {} }).catch(error => error);
    await selected(1);
    headers.set("Authorization", `Bearer ${secondAccess}`);
    const second = client.callTool({ name: "peer_list", arguments: { include_offline: true } });
    await selected(2);
    await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(firstAccess), grant.binding.clientId, Date.now()));
    releases[1]!();
    expect(JSON.stringify(await second)).toContain("alice@example.com/be");
    releases[0]!();
    expect(await first).toBeInstanceOf(Error);
    expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
  } finally { releases.forEach(release => release()); hosted.sessions.snapshot = select; }
});

for (const failure of ["storage", "revoke"] as const) test(`legacy timer contains storage and close failures while healthy users retain capacity: ${failure}`, async () => {
  await hosted.close();
  const callbacks: (() => unknown)[] = [], interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 1000) callbacks.push(fn);
    return interval(fn, ms, ...args);
  }) as typeof setInterval);
  try { hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer, limits: fairLimits }); }
  finally { timers.mockRestore(); }
  await connect("2025-11-25");
  const healthy = await otherClient("2025-11-25");
  let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw new Error("Bearer PRIVATE"); } });
  if (failure === "revoke") await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(token), OPENCODE_CLIENT, Date.now()));
  const restoreAccess = stubAuthRead(store.repo, "findActiveAccess", find => (...args) => { if (failure === "storage" && args[1] === hashToken(token)) throw hostile; return find(...args); });
  const log = spyOn(console, "error").mockImplementation(() => {});
  const serverFault = spyOn(McpServer.prototype, "close").mockImplementation(() => { throw hostile; });
  const transportFault = spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close").mockImplementation(async () => { throw hostile; });
  try {
    await callbacks.at(-1)!();
    expect(hosted.activeLegacySessions).toBe(1);
    expect(reads).toBe(0);
    expect(log.mock.calls).toEqual([[`[grayboard] {"operation":"mcp.legacy","category":"failure","level":"error"}`]]);
    serverFault.mockRestore(); transportFault.mockRestore();
    await callbacks.at(-1)!();
    await healthy.listResources();
    restoreAccess();
    if (failure === "revoke") token = (await issuedOAuth(store.repo, oauth.resource)).token;
    await connect("2025-11-25");
    expect(hosted.activeLegacySessions).toBe(2);
    await expect(connect("2025-11-25")).rejects.toThrow();
    expect(hosted.activeLegacySessions).toBe(2);
  } finally {
    restoreAccess(); serverFault.mockRestore(); transportFault.mockRestore(); log.mockRestore();
  }
});

async function fairCapacity(limits: McpLimits) {
  await hosted.close();
  hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer, limits });
}
const fairLimits: McpLimits = { listen: { global: 3, perUser: 1 }, legacy: { global: 3, perUser: 1 }, post: { global: 8, perUser: 4 } };
async function otherClient(version = "2026-07-28") {
  const original = token;
  token = (await issuedOAuth(store.repo, oauth.resource, "bob@example.com")).token;
  try { return await connect(version); } finally { token = original; }
}
async function capacityRows() {
  return (await auditRows("hosted.capacity_refused")).map(({ actor, detail }) => ({ actor, detail }));
}

test("one authenticated user cannot consume another user's modern listen share", async () => {
  await fairCapacity(fairLimits);
  const first = await connect(), second = await otherClient();
  await first.callTool({ name: "board_create", arguments: { name: "fair", purpose: "fair shares" } });
  const filter = { resourceSubscriptions: ["grayboard://boards/fair"] };
  await expect(first.listen({ resourceSubscriptions: ["grayboard://boards/missing"] })).rejects.toThrow();
  const held = await first.listen(filter);
  await expect(first.listen(filter)).rejects.toThrow();
  expect((await second.callTool({ name: "bind", arguments: { name: "be", create: true } })).isError).not.toBe(true);
  expect((await second.callTool({ name: "board_create", arguments: { name: "other", purpose: "other user's share" } })).isError).not.toBe(true);
  const other = await second.listen({ resourceSubscriptions: ["grayboard://boards/other"] });
  expect(hosted.activeListens).toBe(2);
  expect((await capacityRows())).toEqual([{ actor: "alice@example.com", detail: expect.any(String) }]);
  expect(JSON.parse((await capacityRows())[0]!.detail)).toEqual({ kind: "listen", scope: "user", client_id: OPENCODE_CLIENT });
  await held.close();
  const replacement = await first.listen(filter);
  await replacement.close(); await other.close();
  expect(hosted.activeListens).toBe(0);
});

test("legacy admission is fair and releases its reservation on protocol session deletion", async () => {
  await fairCapacity(fairLimits);
  let sid = "";
  const first = await connect("2025-11-25", async response => { sid = response.headers.get("Mcp-Session-Id") ?? sid; });
  await expect(connect("2025-11-25")).rejects.toThrow();
  const other = await otherClient("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(2);
  expect(JSON.parse((await capacityRows())[0]!.detail)).toMatchObject({ kind: "legacy", scope: "user" });
  const deleted = await hosted.fetch(new Request("http://localhost/mcp", { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sid, "Mcp-Protocol-Version": "2025-11-25" } }));
  expect(deleted.status).toBe(200);
  await first.close();
  await connect("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(2);
  await other.close();
});

for (const ending of ["end", "error", "cancel", "shutdown"] as const) test(`POST fair shares release exactly once after body ${ending}`, async () => {
  await fairCapacity({ ...fairLimits, post: { global: 2, perUser: 1 } });
  const first = await connect(), other = await otherClient();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { entered(); return new Promise<void>(() => {}); } });
  const abort = new AbortController();
  const pending = hosted.fetch(new Request("http://localhost/mcp", { method: "POST", body, signal: abort.signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }));
  await reading;
  // The body's first pull can precede the share: the POST reserves it after authentication, which awaits a pool read on
  // Postgres (#1491).
  await untilHosted(() => hosted.activePosts === 1);
  await expect(first.listResources()).rejects.toThrow();
  await other.listResources();
  expect(JSON.parse((await capacityRows())[0]!.detail)).toMatchObject({ kind: "post", scope: "user" });
  expect((await capacityRows())[0]!.actor).toBe("alice@example.com");
  if (ending === "end") { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
  else if (ending === "error") controller.error(new Error("fixture body error"));
  else if (ending === "cancel") abort.abort();
  else await hosted.close();
  await pending;
  expect(hosted.activePosts).toBe(0);
  if (ending !== "shutdown") { await first.listResources(); await other.listResources(); }
});

test("global POST admission remains bounded across distinct authenticated users", async () => {
  await fairCapacity({ ...fairLimits, post: { global: 2, perUser: 1 } });
  const held = [token, (await issuedOAuth(store.repo, oauth.resource, "bob@example.com")).token].map(access => {
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
    return { abort, response: hosted.fetch(new Request("http://localhost/mcp", { method: "POST", signal: abort.signal, body, headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" } })) };
  });
  try {
    const access = (await issuedOAuth(store.repo, oauth.resource, "third@example.com")).token;
    const refused = await hosted.fetch(new Request("http://localhost/mcp", { method: "POST", body: "{}", headers: { Authorization: `Bearer ${access}` } }));
    expect(refused.status).toBe(429);
    expect(hosted.activePosts).toBe(2);
    expect((await capacityRows())).toEqual([{ actor: "third@example.com", detail: expect.any(String) }]);
    expect(JSON.parse((await capacityRows())[0]!.detail)).toEqual({ kind: "post", scope: "global", client_id: OPENCODE_CLIENT });
  } finally {
    held.forEach(request => request.abort.abort());
    await Promise.all(held.map(request => request.response));
  }
  expect(hosted.activePosts).toBe(0);
  await (await connect()).listResources();
});

// Rebuilds OAuth and hosted MCP on a fake clock and captures the 1 s timers for explicit ticks: `tick` runs every one,
// `tickStream` only the stream timer, which createHostedMcp starts last.
// `manual`: the 1 s timers run only when the test calls tick or tickStream, never on real time.
async function clocked(limits?: McpLimits, streamRecheckMs?: number, manual = false) {
  await hosted.close(); oauth.close();
  const time = { now: Date.now() };
  oauth = createOAuthServer(store.repo, { store: { kind: "sqlite" as const, path: scratchDbPath() }, blobDir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: "https://grayboard.example.com", messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { now: () => time.now });
  const intervals: (() => unknown)[] = [];
  const interval = globalThis.setInterval;
  const spy = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 1000) intervals.push(fn);
    return manual && ms === 1000 ? interval(() => {}, 3_600_000) : interval(fn, ms, ...args);
  }) as typeof setInterval);
  try { hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer, now: () => time.now, ...(limits ? { limits } : {}), ...(streamRecheckMs ? { streamRecheckMs } : {}) }); }
  finally { spy.mockRestore(); }
  // Each resolves once the tick's async work (the stream timer's phase B, #807 P3 A7d) is done.
  return { time, tick: async () => { for (const tick of intervals) await tick(); }, tickStream: async () => { await intervals.at(-1)!(); } };
}

for (const ending of ["revoke", "expiry"] as const) test(`${ending} releases modern and legacy admission before replacements`, async () => {
  const { time, tick } = await clocked(fairLimits);
  token = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const modern = await connect(), legacy = await connect("2025-11-25");
  await modern.callTool({ name: "board_create", arguments: { name: "expiry", purpose: "admission lifecycle" } });
  await modern.listen({ resourceSubscriptions: ["grayboard://boards/expiry"] });
  if (ending === "revoke") await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(token), OPENCODE_CLIENT, time.now));
  else time.now += OAUTH_TTL.access + 1;
  await tick();
  await untilHosted(() => hosted.activeListens === 0 && hosted.activeLegacySessions === 0 && hosted.activePosts === 0);
  // Expiry with the grant active sleeps the legacy session without its admission; a revoked token retires it (#476).
  expect(hosted.dormantLegacySessions).toBe(ending === "expiry" ? 1 : 0);
  token = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const replacement = await connect();
  const listen = await replacement.listen({ resourceSubscriptions: ["grayboard://boards/expiry"] });
  await connect("2025-11-25");
  expect(hosted.activeListens).toBe(1); expect(hosted.activeLegacySessions).toBe(1);
  await listen.close();
  await legacy.close();
});

// #476: a legacy-protocol client (OpenCode's native MCP client) idle past its access token's expiry.
async function dormantFixture(limits?: McpLimits) {
  const { time, tick } = await clocked(limits);
  const grant = await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT);
  token = grant.token;
  const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
  const gets: Request[] = [], hints: string[] = [], sids = new Set<string>();
  const client = await connect("2025-11-25", undefined, headers, request => {
    const sid = request.headers.get("Mcp-Session-Id");
    if (sid) sids.add(sid);
    if (request.method === "GET") gets.push(request);
  });
  client.setNotificationHandler("notifications/resources/updated", n => { hints.push(n.params.uri); });
  const uri = "grayboard://boards/dormant";
  expect((await client.callTool({ name: "board_create", arguments: { name: "dormant", purpose: "legacy dormancy" } })).isError).not.toBe(true);
  expect(await client.subscribeResource({ uri })).toEqual({});
  await untilHosted(() => hosted.activeGetStreams === 1);
  expect(sids.size).toBe(1);
  let refresh = grant.refreshToken;
  return {
    client, gets, hints, sids, uri, grant, headers, time, tick, sid: [...sids][0]!,
    // Rotates the refresh token on the same grant and sends the new access token from then on.
    async refresh() {
      const { access, refresh: next, status } = await rotateOAuth(store.repo, grant, refresh, time.now);
      expect(status).toBe("ok");
      refresh = next;
      headers.set("Authorization", `Bearer ${access}`);
      return access;
    },
  };
}
const legacyRows = async () => (await (drained(store.repo).then(() => rows<{ action: string; target: string | null; detail: string }>(store.repo, "SELECT action, target, detail FROM access_log WHERE action LIKE 'hosted.legacy%' ORDER BY id"))))
  .map((row): Record<string, unknown> => ({ action: row.action, target: row.target, ...JSON.parse(row.detail) as Record<string, unknown> }));
const rawLegacy = (method: string, sid: string, access: string) => hosted.fetch(new Request("http://localhost/mcp", { method, headers: {
  Authorization: `Bearer ${access}`, "Mcp-Session-Id": sid, "Mcp-Protocol-Version": "2025-11-25", Accept: "application/json, text/event-stream",
} }));

test("a legacy session idle past access expiry sleeps without admission and resumes on the same sid after refresh", async () => {
  const f = await dormantFixture();
  const logged = spyOn(console, "error");
  const hostedId = sessionContext((await oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${f.grant.token}` } }))) as OAuthPrincipal, meta);
  f.time.now += OAUTH_TTL.access + 1;
  await f.refresh();
  await f.tick();
  expect(hosted.activeLegacySessions).toBe(0);
  expect(hosted.dormantLegacySessions).toBe(1);
  expect(hosted.activeGetStreams).toBe(0);
  // The SDK client reopens its GET on the same sid with the refreshed token; that request re-admits the session.
  await untilHosted(() => f.gets.length === 2 && hosted.activeGetStreams === 1, 5000);
  expect(hosted.activeLegacySessions).toBe(1);
  expect(hosted.dormantLegacySessions).toBe(0);
  expect((await f.client.callTool({ name: "board_post", arguments: { board: "dormant", body: "after rollover" } })).isError).not.toBe(true);
  await untilHosted(() => f.hints.length === 1, 5000);
  expect(f.hints).toEqual([f.uri]);
  expect([...f.sids]).toEqual([f.sid]);
  const rows = await legacyRows();
  const target = "id" in hostedId ? hostedId.id : null;
  expect(rows).toEqual([
    { action: "hosted.legacy_dormant", target, subscriptions: 1, ref: expect.any(String), grant: f.grant.grantId, client_id: OPENCODE_CLIENT },
    { action: "hosted.legacy_rehydrated", target, dormant_ms: expect.any(Number), ref: rows[0]!.ref, grant: f.grant.grantId, client_id: OPENCODE_CLIENT },
  ]);
  expect(JSON.stringify(rows)).not.toContain(f.sid);
  // The close row is a posted write, which may wait behind a body phase B started (#807 P3 A7d).
  await until(async () => (await closedReasons()).length >= 1, 1000, "a stream_closed row");
  expect(await closedReasons()).toEqual(["access_expired"]);
  // The expected close is audited above, not logged as a stream failure (#494 item 10).
  expect(logged.mock.calls.filter(args => String(args[0]).includes("mcp.stream"))).toEqual([]);
  logged.mockRestore();
});

test("a dormant sid answers 404 to another binding and only its own user's new grant drops it", async () => {
  const f = await dormantFixture();
  f.time.now += OAUTH_TTL.access + 1;
  await f.tick();
  expect(hosted.dormantLegacySessions).toBe(1);
  const stranger = (await issueOAuth(store.repo, oauth.resource, "bob@example.com", ["grayboard:tools"], f.time.now, OPENCODE_CLIENT)).token;
  expect((await rawLegacy("GET", f.sid, stranger)).status).toBe(404);
  expect(hosted.dormantLegacySessions).toBe(1);
  const regranted = await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], f.time.now, OPENCODE_CLIENT);
  expect((await rawLegacy("GET", f.sid, regranted.token)).status).toBe(404);
  expect(hosted.dormantLegacySessions).toBe(0);
  expect((await legacyRows()).map(row => [row.action, row.reason])).toEqual([["hosted.legacy_dormant", undefined], ["hosted.legacy_dropped", "grant_changed"]]);
  // The drop row names both grants: the one the session had and the one that dropped it (#494 item 9).
  expect((await legacyRows())[1]).toMatchObject({ grant: f.grant.grantId, new_grant: regranted.grantId });
  // Dropped is never resurrected, even for the original grant.
  expect((await rawLegacy("GET", f.sid, (await f.refresh()))).status).toBe(404);
});

for (const ending of ["idle", "grant_ended", "deleted", "shutdown"] as const) test(`a dormant legacy session is dropped: ${ending}`, async () => {
  const f = await dormantFixture();
  f.time.now += OAUTH_TTL.access + 1;
  await f.tick();
  expect(hosted.dormantLegacySessions).toBe(1);
  if (ending === "idle") {
    f.time.now += 59_999; await f.tick();
    expect(hosted.dormantLegacySessions).toBe(1);
    f.time.now += 1; await f.tick();
  } else if (ending === "grant_ended") {
    await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(f.grant.refreshToken), OPENCODE_CLIENT, f.time.now));
    await f.tick();
  } else if (ending === "shutdown") {
    await hosted.close();
  } else {
    // Teardown reserves no admission.
    expect((await rawLegacy("DELETE", f.sid, (await f.refresh()))).status).toBe(200);
  }
  expect(hosted.dormantLegacySessions).toBe(0);
  expect(hosted.activeLegacySessions).toBe(0);
  expect((await legacyRows()).map(row => [row.action, row.reason])).toEqual([["hosted.legacy_dormant", undefined], ["hosted.legacy_dropped", ending]]);
  if (ending !== "grant_ended" && ending !== "shutdown") expect((await rawLegacy("GET", f.sid, (await f.refresh()))).status).toBe(404);
});

test("a full legacy limit refuses rehydration with the session's ref, keeps it dormant, and still lets DELETE drop it (#494 items 1, 3, 7)", async () => {
  const f = await dormantFixture({ ...DEFAULT_MCP_LIMITS, legacy: { global: 1, perUser: 1 } });
  f.time.now += OAUTH_TTL.access + 1;
  await f.tick();
  expect(hosted.dormantLegacySessions).toBe(1);
  // Another legacy session takes the only admission.
  token = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], f.time.now, OPENCODE_CLIENT)).token;
  await connect("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(1);
  const access = await f.refresh();
  expect((await rawLegacy("GET", f.sid, access)).status).toBe(429);
  expect(hosted.dormantLegacySessions).toBe(1);
  const refused = (await auditRows("hosted.capacity_refused")).map(r => JSON.parse(r.detail));
  expect(refused).toEqual([expect.objectContaining({ kind: "legacy", ref: (await legacyRows())[0]!.ref })]);
  // Teardown needs no admission, even with the limit full.
  expect((await rawLegacy("DELETE", f.sid, access)).status).toBe(200);
  expect(hosted.dormantLegacySessions).toBe(0);
  expect(hosted.activeLegacySessions).toBe(1);
  expect((await legacyRows()).map(row => [row.action, row.reason])).toEqual([["hosted.legacy_dormant", undefined], ["hosted.legacy_dropped", "deleted"]]);
});

test("the dormant registry is bounded by the legacy limits", async () => {
  const f = await dormantFixture({ ...DEFAULT_MCP_LIMITS, legacy: { global: 1, perUser: 1 } });
  f.time.now += OAUTH_TTL.access + 1;
  await f.tick();
  expect(hosted.dormantLegacySessions).toBe(1);
  // A second session whose token expires inside the first one's idle window finds the dormant bound full.
  token = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], f.time.now - OAUTH_TTL.access + 30_000, OPENCODE_CLIENT)).token;
  await connect("2025-11-25");
  await untilHosted(() => hosted.activeGetStreams === 1);
  expect(hosted.activeLegacySessions).toBe(1);
  f.time.now += 30_000;
  await f.tick();
  expect(hosted.activeLegacySessions).toBe(0);
  expect(hosted.dormantLegacySessions).toBe(1);
  expect((await legacyRows()).map(row => [row.action, row.reason])).toEqual([["hosted.legacy_dormant", undefined], ["hosted.legacy_dropped", "capacity"]]);
  const refused = await auditRows("hosted.capacity_refused");
  expect(refused.map(row => JSON.parse(row.detail).kind)).toEqual(["dormant"]);
  // The dropped session's GET still gets its close row.
  // The close row is a posted write, which may wait behind a body phase B started (#807 P3 A7d).
  await until(async () => (await closedReasons()).length >= 2, 1000, "two stream_closed rows");
  expect(await closedReasons()).toEqual(["access_expired", "access_expired"]);
});

test("modern listen capacity is reserved and reusable after cancellation", async () => {
  await hosted.close();
  hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer, limits: { ...DEFAULT_MCP_LIMITS, listen: { global: 128, perUser: 128 }, post: { global: 256, perUser: 256 } } });
  const client = await connect();
  await client.callTool({ name: "board_create", arguments: { name: "bounded", purpose: "listen quota" } });
  const filter = { resourceSubscriptions: ["grayboard://boards/bounded"] };
  const subscriptions = [];
  for (let i = 0; i < 128; i++) subscriptions.push(await client.listen(filter));
  expect(hosted.activeListens).toBe(128);
  expect(hosted.activeBusListeners).toBe(128);
  await expect(client.listen(filter)).rejects.toThrow();
  await Promise.all(subscriptions.map(sub => sub.close()));
  await untilHosted(() => hosted.activeListens === 0 && hosted.activeBusListeners === 0);
  const replacement = await client.listen(filter);
  await replacement.close();
});

test("legacy registry is bounded and idle disconnected sessions are reclaimed", async () => {
  await hosted.close();
  let clock = Date.now();
  hosted = createHostedMcp(application, oauth, { trustedOrigin: oauth.issuer, now: () => clock, limits: { ...DEFAULT_MCP_LIMITS, legacy: { global: 256, perUser: 256 } } });
  for (let i = 0; i < 256; i++) await connect("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(256);
  await expect(connect("2025-11-25")).rejects.toThrow();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await untilHosted(() => hosted.activeGetStreams === 0);
  clock += 60_001;
  // The idle sweep runs on a 1 s timer: wait for its effect, not a sleep sized to one tick (#466).
  await untilHosted(() => hosted.activeLegacySessions === 0 && hosted.activeContexts === 0, 10_000);
  await connect("2025-11-25");
  expect(hosted.activeLegacySessions).toBe(1);
}, 30_000);

test("global board watch bound cleans partial acquisitions without retiring other listeners", async () => {
  const client = await connect();
  const uris = [];
  for (let i = 0; i < 32; i++) {
    await client.callTool({ name: "board_create", arguments: { name: `b${i}`, purpose: "bounded watches" } });
    uris.push(`grayboard://boards/b${i}`);
  }
  await expect(client.listen({ resourceSubscriptions: [...uris, "grayboard://identity"] })).rejects.toThrow();
  expect(hosted.activeWatches).toBe(0);
  const subscriptions = [];
  for (let i = 0; i < 32; i++) subscriptions.push(await client.listen({ resourceSubscriptions: uris }));
  expect(hosted.activeWatches).toBe(1024);
  await expect(client.listen({ resourceSubscriptions: uris })).rejects.toThrow();
  expect(hosted.activeWatches).toBe(1024);
  expect(hosted.activeListens).toBe(32);
  await Promise.all(subscriptions.map(sub => sub.close()));
  await untilHosted(() => hosted.activeWatches === 0);
});

test("shutdown awaits pending original request source cancellation", async () => {
  let release!: () => void, cancelStarted = false, closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel: async () => { cancelStarted = true; await gate; } });
  const request = new Request("http://localhost/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
  const pending = hosted.fetch(request);
  await Bun.sleep(0);
  const closing = hosted.close().then(() => { closed = true; });
  await Bun.sleep(0);
  expect(cancelStarted).toBe(true); expect(closed).toBe(false);
  release();
  await closing; await pending;
  expect(body.locked).toBe(false);
  expect(hosted.activePosts).toBe(0);
});

async function untilHosted(predicate: () => boolean, ms = 1000) {
  const deadline = performance.now() + ms;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

async function legacyWatchFixture(version: string, headers?: Headers) {
  const gets: Request[] = [], hints: string[] = [];
  const client = await connect(version, undefined, headers, request => { if (request.method === "GET") gets.push(request); });
  client.setNotificationHandler("notifications/resources/updated", n => { hints.push(n.params.uri); });
  expect((await client.callTool({ name: "board_create", arguments: { name: "rollback", purpose: "watch acquisition" } })).isError).not.toBe(true);
  await untilHosted(() => hosted.activeGetStreams === 1);
  return { client, gets, hints, uri: "grayboard://boards/rollback" };
}

for (const version of ["2025-11-25", "2025-06-18"]) for (const kind of ["database", "internal"] as const) test(`${version}: ${kind} observer failure rolls back registration and retry installs exactly one watch`, async () => {
  const { client, gets, hints, uri } = await legacyWatchFixture(version);
  const original = application.observeBoard;
  const fault = kind === "internal" ? new ApplicationError("internal", "SELECT secret FROM private_storage") : new Error("SELECT secret FROM private_storage");
  let failing = true, attempts = 0;
  application.observeBoard = (...args) => { attempts++; if (failing) throw fault; return original(...args); };
  try {
    await expect(client.subscribeResource({ uri: "grayboard://boards/missing" })).rejects.toMatchObject({ code: -32602 });
    expect(attempts).toBe(0);
    const failure = await client.subscribeResource({ uri }).catch(error => error);
    expect(failure).toMatchObject({ code: -32603 });
    expect(failure.message).toContain("internal error");
    expect(failure.message).not.toContain("private_storage");
    expect(hosted.activeWatches).toBe(0);
    expect(hosted.activeGetStreams).toBe(1);
    expect(gets).toHaveLength(1);
    expect(attempts).toBe(1);
    failing = false;
    expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "unregistered" } })).isError).not.toBe(true);
    expect(hints).toEqual([]);
    expect(await client.subscribeResource({ uri })).toEqual({});
    expect(hosted.activeWatches).toBe(1);
    expect(await client.subscribeResource({ uri })).toEqual({});
    expect(hosted.activeWatches).toBe(1);
    expect(attempts).toBe(2);
    expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "registered" } })).isError).not.toBe(true);
    await untilHosted(() => hints.length === 1);
    expect(hints).toEqual([uri]);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.signal.aborted).toBe(false);
    expect(await store.repo.cursors.directFor(store.repo.read, "alice@example.com/be")).toBe(0);
    await client.unsubscribeResource({ uri });
    expect(hosted.activeWatches).toBe(0);
  } finally { application.observeBoard = original; }
});

for (const version of ["2025-11-25", "2025-06-18"]) for (const kind of ["database", "internal"] as const) test(`${version}: ${kind} fault checking the old GET is an internal error, not a successful registration`, async () => {
  const grant = await issuedOAuth(store.repo, oauth.resource);
  const headers = new Headers({ Authorization: `Bearer ${grant.token}` });
  const { client, gets, hints, uri } = await legacyWatchFixture(version, headers);
  // A watched resource keeps the GET attached, so the next subscribe checks it with its old token.
  expect((await client.callTool({ name: "board_create", arguments: { name: "watched", purpose: "keeps the GET attached" } })).isError).not.toBe(true);
  expect(await client.subscribeResource({ uri: "grayboard://boards/watched" })).toEqual({});
  const { access, status } = await rotateOAuth(store.repo, grant, grant.refreshToken);
  expect(status).toBe("ok");
  headers.set("Authorization", `Bearer ${access}`);
  const fault = kind === "internal" ? new ApplicationError("internal", "SELECT secret FROM private_storage") : new Error("SELECT secret FROM private_storage");
  let oldChecks = 0;
  const restoreAccess = stubAuthRead(store.repo, "findActiveAccess", original => (...args) => {
    if (args[1] === grant.tokens.accessHash) { oldChecks++; throw fault; }
    return original(...args);
  });
  try {
    const failure = await client.subscribeResource({ uri }).catch(error => error);
    expect(failure).toMatchObject({ code: -32603 });
    expect(failure.message).toContain("internal error");
    expect(failure.message).not.toContain("private_storage");
    expect(oldChecks).toBe(1);
    expect(hosted.activeWatches).toBe(1);
    expect(hosted.activeGetStreams).toBe(1);
    expect(gets).toHaveLength(1);
  } finally { restoreAccess(); }
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "unregistered" } })).isError).not.toBe(true);
  expect(hints).toEqual([]);
  expect(await client.subscribeResource({ uri })).toEqual({});
  expect(hosted.activeWatches).toBe(2);
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "recovered" } })).isError).not.toBe(true);
  await untilHosted(() => hints.length === 1);
  expect(hints).toEqual([uri]);
  expect(gets).toHaveLength(1);
});

// #431: an idle GET attaches by re-selecting its context; a fault there fails the subscribe.
for (const kind of ["database", "internal"] as const) test(`${kind} fault attaching an idle legacy GET is an internal error, not a successful registration`, async () => {
  const { client, gets, hints, uri } = await legacyWatchFixture("2025-11-25");
  const original = hosted.sessions.snapshot;
  const fault = kind === "internal" ? new ApplicationError("internal", "SELECT secret FROM private_storage") : new Error("SELECT secret FROM private_storage");
  // The subscribe POST selects its own context first; the attach is the second selection.
  let calls = 0;
  hosted.sessions.snapshot = (...args) => { if (++calls === 2) throw fault; return original(...args); };
  try {
    const failure = await client.subscribeResource({ uri }).catch(error => error);
    expect(failure).toMatchObject({ code: -32603 });
    expect(failure.message).toContain("internal error");
    expect(failure.message).not.toContain("private_storage");
    expect(calls).toBe(2);
    expect(hosted.activeWatches).toBe(0);
  } finally { hosted.sessions.snapshot = original; }
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "unregistered" } })).isError).not.toBe(true);
  expect(hints).toEqual([]);
  expect(await client.subscribeResource({ uri })).toEqual({});
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "recovered" } })).isError).not.toBe(true);
  await untilHosted(() => hints.length === 1);
  expect(hints).toEqual([uri]);
  expect(gets).toHaveLength(1);
});

test("a refusal attaching an idle legacy GET ends that GET; the subscription stays registered for the reopened one", async () => {
  const { client, gets, hints, uri } = await legacyWatchFixture("2025-11-25");
  const original = hosted.sessions.snapshot;
  // The subscribe POST selects its own context first; the attach is the second selection.
  let calls = 0;
  hosted.sessions.snapshot = (...args) => { if (++calls === 2) throw new ApplicationError("unauthenticated", "unauthenticated"); return original(...args); };
  try { expect(await client.subscribeResource({ uri })).toEqual({}); }
  finally { hosted.sessions.snapshot = original; }
  expect(calls).toBe(2);
  // The SDK client reopens an ended GET after its 1000 ms initialReconnectionDelay, so a 1 s window races it (#466).
  await untilHosted(() => gets.length === 2 && hosted.activeWatches === 1, 5000);
  expect((await client.callTool({ name: "board_post", arguments: { board: "rollback", body: "after refusal" } })).isError).not.toBe(true);
  await untilHosted(() => hints.length === 1);
  expect(hints).toEqual([uri]);
});

test("authentication storage errors return a redacted HTTP 500 before identity selection", async () => {
  const restoreAccess = stubAuthRead(store.repo, "findActiveAccess", () => () => { throw new Error("SELECT secret FROM /private/oauth.sqlite"); });
  try {
    const response = await hosted.fetch(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "internal", message: "internal error" });
    expect(await store.repo.aliases.find(store.repo.read, `${user.user_email}/unselected`)).toBeUndefined();
  } finally { restoreAccess(); }
  expect(hosted.activeContexts).toBe(hosted.activeGetStreams);
});

// A raw initialized 2025-11-25 session: `post` (under another access token when given) and `get` (unawaited by it).
async function rawLegacySession(access: string, initMeta?: Record<string, unknown>, extra: Record<string, string> = {}) {
  const base = { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra };
  let next = 1;
  const send = async (headers: Record<string, string>, method: string, params?: Record<string, unknown>) => {
    const response = await hosted.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: next++ }), method, ...(params ? { params } : {}) }) }));
    return { response, text: await response.text() };
  };
  const init = await send(base, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" }, ...(initMeta ? { _meta: initMeta } : {}) });
  const headers = { ...base, "Mcp-Session-Id": init.response.headers.get("Mcp-Session-Id")!, "Mcp-Protocol-Version": "2025-11-25" };
  await send(headers, "notifications/initialized");
  return {
    headers,
    post: (method: string, params?: Record<string, unknown>, as?: string) => send(as ? { ...headers, Authorization: `Bearer ${as}` } : headers, method, params),
    get: (signal: AbortSignal) => hosted.fetch(new Request("http://localhost/mcp", { method: "GET", headers, signal })),
    delete: () => hosted.fetch(new Request("http://localhost/mcp", { method: "DELETE", headers })),
  };
}

// #431: a raw 2025-11-25 standalone GET, as omp's native client opens it (1 s header timeout, no reopen).
async function rawLegacyGet(access: string, initMeta?: Record<string, unknown>, extra: Record<string, string> = {}) {
  const session = await rawLegacySession(access, initMeta, extra);
  const { headers } = session, post = (_headers: Record<string, string>, method: string, params?: Record<string, unknown>) => session.post(method, params);
  const abort = new AbortController();
  const get = await session.get(abort.signal);
  const reader = get.body!.getReader();
  let ended = false, received = "";
  // Resolves once the stream's text so far satisfies `done`, or with what arrived by the deadline.
  const until = async (done: (text: string) => boolean, ms = 1000) => {
    const deadline = AbortSignal.timeout(ms);
    const expired = Promise.withResolvers<undefined>();
    deadline.addEventListener("abort", () => expired.resolve(undefined), { once: true });
    while (!ended && !done(received) && !deadline.aborted) {
      const chunk = await Promise.race([reader.read(), expired.promise]);
      if (!chunk) break;
      if (chunk.done) ended = true;
      else received += new TextDecoder().decode(chunk.value);
    }
    return received;
  };
  return {
    get, until, get ended() { return ended; }, abort: () => abort.abort(),
    call: (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => post(headers, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }),
    subscribe: (uri: string, meta?: Record<string, unknown>) => post(headers, "resources/subscribe", { uri, ...(meta ? { _meta: meta } : {}) }),
    async close() { abort.abort(); await reader.cancel().catch(() => {}); await hosted.fetch(new Request("http://localhost/mcp", { method: "DELETE", headers })); },
  };
}

const UNBOUND_GETS = [
  { label: "initialize without _meta", initMeta: undefined },
  { label: "_meta for a never-bound session", initMeta: { "ai.opencode/sessionID": "never-bound" } },
] as const;

for (const { label, initMeta } of [...UNBOUND_GETS, { label: "_meta for a bound session", initMeta: meta }]) test(`legacy GET (${label}) sends its first bytes at once`, async () => {
  const raw = await rawLegacyGet(token, initMeta);
  try {
    expect(raw.get.status).toBe(200);
    expect(raw.get.headers.get("Content-Type")).toContain("text/event-stream");
    // Well under the 5 s keepalive, so it can only be the priming bytes.
    expect(await raw.until(text => text.length > 0)).toBe(": keepalive\n\n");
  } finally { await raw.close(); }
});

test("a subscriber-role legacy GET without a lease stays open, primed, across a hosted change", async () => {
  const access = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT)).token;
  const raw = await rawLegacyGet(access, undefined, { "X-Grayboard-Client": "subscriber" });
  try {
    expect(await raw.until(text => text.length > 0)).toBe(": keepalive\n\n");
    // The reconcile runs synchronously inside the sweep's commit, so a stop would already show here.
    await hosted.sessions.sweep();
    expect(hosted.activeGetStreams).toBe(1);
  } finally { await raw.close(); }
});

for (const { label, initMeta } of UNBOUND_GETS) test(`an unbound legacy GET (${label}) stays open through a bind and carries the later subscription's hints`, async () => {
  const raw = await rawLegacyGet(token, initMeta);
  try {
    expect(await raw.until(text => text.length > 0)).toBe(": keepalive\n\n");
    const fresh = { "ai.opencode/sessionID": "fresh-root" };
    // The bind is a hosted change: before #431 its reconcile ended every unbound GET.
    expect((await raw.call("bind", { name: "fe", create: true }, fresh)).text).not.toContain("isError\":true");
    expect((await raw.call("board_create", { name: "attach", purpose: "legacy attach" }, fresh)).text).not.toContain("isError\":true");
    expect(raw.ended).toBe(false);
    expect((await raw.subscribe("grayboard://boards/attach", fresh)).text).not.toContain("\"error\"");
    expect(hosted.activeWatches).toBe(1);
    expect((await raw.call("board_post", { board: "attach", body: "hint me" }, fresh)).text).not.toContain("isError\":true");
    const text = await raw.until(t => t.includes("notifications/resources/updated"));
    expect(text).toContain("\"uri\":\"grayboard://boards/attach\"");
    expect(raw.ended).toBe(false);
    expect(hosted.activeGetStreams).toBe(1);
  } finally { await raw.close(); }
});

// #939: the attach re-indexes the GET by its new binding rows, so a later commit to those rows still reaches it. The
// `never-bound` variant opens indexed by another row, so it fails if the attach skips the re-index; the no-_meta one
// opens row-less, which every commit checks.
for (const { label, initMeta } of UNBOUND_GETS) test(`an idle legacy GET (${label}) attached by a subscribe ends when its new binding does`, async () => {
  const raw = await rawLegacyGet(token, initMeta);
  const fresh = { "ai.opencode/sessionID": "fresh-root" };
  try {
    expect(await raw.until(text => text.length > 0)).toBe(": keepalive\n\n");
    expect((await raw.call("bind", { name: "fe", create: true }, fresh)).text).not.toContain("isError\":true");
    expect((await raw.call("board_create", { name: "attach", purpose: "legacy attach" }, fresh)).text).not.toContain("isError\":true");
    expect((await raw.subscribe("grayboard://boards/attach", fresh)).text).not.toContain("\"error\"");
    expect(hosted.activeGetStreams).toBe(1);
    // Unbinding the last name is a commit to the attached binding's row. The reconcile runs inside that commit, so
    // the stop shows as soon as the call returns, not at the stream timer's next check.
    expect((await raw.call("unbind", { name: "fe" }, fresh)).text).not.toContain("isError\":true");
    expect(hosted.activeGetStreams).toBe(0);
  } finally { await raw.close(); }
});

test("a legacy GET closed while a subscribe attaches it ends quietly; the subscription stays registered", async () => {
  const raw = await rawLegacyGet(token);
  const fresh = { "ai.opencode/sessionID": "fresh-root" };
  const original = hosted.sessions.snapshot;
  try {
    expect(await raw.until(text => text.length > 0)).toBe(": keepalive\n\n");
    expect((await raw.call("bind", { name: "fe", create: true }, fresh)).text).not.toContain("isError\":true");
    expect((await raw.call("board_create", { name: "attach", purpose: "legacy attach" }, fresh)).text).not.toContain("isError\":true");
    // The subscribe POST selects its own context first; the GET closes during the attach's selection.
    let calls = 0;
    hosted.sessions.snapshot = (...args) => { if (++calls === 2) raw.abort(); return original(...args); };
    const subscribed = await raw.subscribe("grayboard://boards/attach", fresh);
    expect(calls).toBe(2);
    expect(subscribed.text).toContain("\"result\":{}");
    await untilHosted(() => hosted.activeGetStreams === 0);
    expect(hosted.activeWatches).toBe(0);
  } finally { hosted.sessions.snapshot = original; await raw.close(); }
});

test("concurrent legacy subscribes from two session contexts register only one", async () => {
  const raw = await rawLegacyGet(token);
  const a = { "ai.opencode/sessionID": "root-a" }, b = { "ai.opencode/sessionID": "root-b" };
  try {
    expect((await raw.call("bind", { name: "conc-a", create: true }, a)).text).not.toContain("isError\":true");
    expect((await raw.call("bind", { name: "conc-b", create: true }, b)).text).not.toContain("isError\":true");
    expect((await raw.call("board_create", { name: "attach", purpose: "legacy attach" }, a)).text).not.toContain("isError\":true");
    const results = await Promise.all([raw.subscribe("grayboard://boards/attach", a), raw.subscribe("grayboard://boards/attach", b)]);
    // Either may win: on Postgres the two race through pool reads before the write queue orders them (#1491).
    expect(results.map(r => r.text.includes("\"error\"")).sort()).toEqual([false, true]);
    expect(hosted.activeWatches).toBe(1);
  } finally { await raw.close(); }
});

for (const { label, initMeta } of UNBOUND_GETS) test(`peer_list doesn't show an idle legacy GET (${label}) as an unbound session`, async () => {
  const raw = await rawLegacyGet(token, initMeta);
  const fresh = { "ai.opencode/sessionID": "fresh-root" };
  try {
    expect(await raw.until(text => text.length > 0)).toBe(": keepalive\n\n");
    expect((await raw.call("bind", { name: "fe", create: true }, fresh)).text).not.toContain("isError\":true");
    const listed = await raw.call("peer_list", {}, fresh);
    expect(listed.text).not.toContain("isError\":true");
    expect(listed.text).not.toContain("unbound_sessions");
    expect(hosted.activeGetStreams).toBe(1);
  } finally { await raw.close(); }
});

test("an unbound native hosted session lists itself once in peer_list's unbound_sessions (#489)", async () => {
  const raw = await rawLegacyGet(token);
  const fresh = { "ai.opencode/sessionID": "lone-root" };
  try {
    const listed = await raw.call("peer_list", {}, fresh);
    const data = JSON.parse(listed.text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    const unbound = JSON.parse(data.result.content[0].text).unbound_sessions as { session_id: string; self?: true }[];
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).toMatchObject({ self: true });
  } finally { await raw.close(); }
});

// #399: a hosted commit names the row it changed, and only the listens reading that row re-check their binding.
test("an unbind stops only its own session's listen, through the per-row notice (#399)", async () => {
  const first = await connect(), second = await otherClient();
  expect((await first.callTool({ name: "bind", arguments: { name: "fe", create: true } })).isError).not.toBe(true);
  expect((await first.callTool({ name: "board_create", arguments: { name: "mine", purpose: "first's watch" } })).isError).not.toBe(true);
  expect((await second.callTool({ name: "bind", arguments: { name: "be", create: true } })).isError).not.toBe(true);
  expect((await second.callTool({ name: "board_create", arguments: { name: "theirs", purpose: "second's watch" } })).isError).not.toBe(true);
  const kept = await first.listen({ resourceSubscriptions: ["grayboard://boards/mine"] });
  await second.listen({ resourceSubscriptions: ["grayboard://boards/theirs"] });
  expect(hosted.activeListens).toBe(2);
  // A binding change committed outside any request of either session, so only the notice can reach the listens.
  const rebind = async (email: string) => {
    const userId = (await store.repo.users.findByEmail(store.repo.read, email))!.id;
    await seed(store.repo, async tx => {
      const row = (await store.repo.hosted.all(tx)).find(r => r.user_id === userId)!;
      return store.repo.hosted.update(tx, row.session_id, { bind_gen: row.bind_gen + 1 });
    });
  };
  await rebind("bob@example.com");
  await untilHosted(() => hosted.activeListens === 1);
  await rebind("alice@example.com");
  await untilHosted(() => hosted.activeListens === 0);
  await kept.close();
});

// Every call to a Repo group's method (repo.hosted.get, repo.bindings.holdsOf, …) until restore(), with whether its
// handle was a body's Tx (#1497): the backend-agnostic oracle for which rows a path reads, and on what. Callers reach
// the groups through the Repo's own objects (hosted.ts's `store` is repo.hosted), so a replaced method sees each call.
function repoCalls(repo: Repo): { readonly list: { method: string; tx: boolean }[]; restore(): void } {
  const list: { method: string; tx: boolean }[] = [], restores: (() => void)[] = [];
  for (const [group, value] of Object.entries(repo)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const g = value as Record<string, unknown>;
    for (const [name, fn] of Object.entries(g)) {
      if (typeof fn !== "function") continue;
      g[name] = function (this: unknown, ...args: unknown[]) {
        list.push({ method: `${group}.${name}`, tx: isTx(args[0] as Read) });
        return (fn as (...a: unknown[]) => unknown).apply(this, args);
      };
      restores.push(() => { g[name] = fn; });
    }
  }
  return { list, restore() { for (const r of restores.reverse()) r(); } };
}
// Allowlists, not lists of the methods that read a table: many Repo methods read alias_holds or hosted_sessions inside
// their SQL (aliases.seen, claims, boards' delivery reads, the session end…), and a denylist misses the one it forgets.
// B1b: the calls the notice may make outside a body's Tx. hosted.takeEnded takes no handle and reads no row.
const NOTICE_OFF_TX = new Set(["hosted.takeEnded"]);
// #899: the methods quiet ticks may call, on either backend: board visibility and the auth cache's refills, none of
// which reads hosted_sessions or alias_holds (pg/boards.ts get, pg/identity.ts principals.of, pg/oauth.ts).
const QUIET_TICK = new Set(["boards.get", "oauth.findActiveAccess", "users.active", "principals.of"]);

// #807 P3 B1b: a commit's notice judges a live synchronously, so whether its root holds a name comes from the stamp
// its authorize read with the generation, never from a holds read outside a transaction.
// The oracle (#1497): every Repo call during the commit and its notice, each with whether its handle was a body's Tx;
// none but NOTICE_OFF_TX may run outside one, so no holds read (nor any other) is made on a pool Read. The handle, not
// txSpy's open count: a judge in the commit's afterCommit runs while its body still counts open.
test("#807 P3 B1b: a notice that keeps a bound root's generation keeps its listen, judged with no holds read", async () => {
  const client = await connect();
  expect((await client.callTool({ name: "bind", arguments: { name: "fe", create: true } })).isError).not.toBe(true);
  expect((await client.callTool({ name: "board_create", arguments: { name: "held", purpose: "B1b" } })).isError).not.toBe(true);
  const listen = await client.listen({ resourceSubscriptions: ["grayboard://boards/held"] });
  expect(hosted.activeListens).toBe(1);
  const root = async (r: Read) => (await store.repo.hosted.all(r)).find(row => !row.root_session_id && row.user_id === user.user_id)!;
  // Holds reads outside any transaction: the pool's, as bindingLive's was before B1b.
  const calls = repoCalls(store.repo);
  try {
    // A commit to the root's row that leaves its generation: its notice carries the row, and the judge keeps the live.
    await seed(store.repo, async tx => { const r = await root(tx); return store.repo.hosted.update(tx, r.session_id, { last_seen_at: r.last_seen_at + 1 }); });
    expect(hosted.activeListens).toBe(1);
    expect(calls.list.filter(c => !c.tx && !NOTICE_OFF_TX.has(c.method))).toEqual([]);
    expect(calls.list.some(c => c.method === "hosted.update" && c.tx)).toBe(true); // the oracle sees the commit's calls
  } finally { calls.restore(); }
  // The same path still stops it once the generation moves.
  await seed(store.repo, async tx => { const r = await root(tx); return store.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 }); });
  await untilHosted(() => hosted.activeListens === 0);
  await listen.close();
});

// The row reads are the Repo's by-ID reads of a hosted row, hosted.get and hosted.lock (#1497): on SQLite, the only
// two that run `SELECT * FROM hosted_sessions WHERE session_id = ?`, the statement this counted before.
test("#902: a native tool call authorizes under one auth-generation read and leaves its row to the hosted gate", async () => {
  const client = await connect();
  await client.callTool({ name: "board_list", arguments: {} });
  // The exchange's authorization check reads through the async form since #807 P3 A7d.
  const authRead = store.repo.authRead, validate = application.revalidateSession;
  let depth = 0, pinned = 0, unpinned = 0;
  store.repo.authRead = async fn => { depth++; try { return await authRead(fn); } finally { depth--; } };
  application.revalidateSession = (session, allowUnbound) => { if (depth) pinned++; else unpinned++; return validate(session, allowUnbound); };
  const calls = repoCalls(store.repo);
  try {
    const listed = await client.callTool({ name: "board_list", arguments: {} });
    expect(listed.isError).not.toBe(true);
    const rowReads = calls.list.filter(c => c.method === "hosted.get" || c.method === "hosted.lock").length;
    // Before #902: nine row reads (authorize's own, besides the exchange's and the tool's hosted gates), and the
    // user check outside the grant check's generation read. Before #907: eight; before #998: five. Now four: the
    // exchange's gate reads the row and settles it; the tool's gate checks the exchange's verdict still holds and
    // fences in its transaction. The bound instructions reuse the verdict's root, the exchange skips its end touch,
    // and the call ends inside the touch window, so its end touch reads nothing.
    expect(rowReads).toBe(4);
    expect({ pinned, unpinned }).toEqual({ pinned: 1, unpinned: 0 });
  } finally { calls.restore(); store.repo.authRead = authRead; application.revalidateSession = validate; }
});

// #899: the stream timer re-reads a live's hosted rows only when they could have changed. A listen checked once
// (stamped), then each way it can end, within a tick of the write or deadline that ends it.
async function stampedListen(recheckMs = 3_600_000, manual = false) {
  const { time, tick, tickStream } = await clocked(undefined, recheckMs, manual);
  const grant = await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT);
  token = grant.token;
  const client = await connect();
  expect((await client.callTool({ name: "board_create", arguments: { name: "stamped", purpose: "#899" } })).isError).not.toBe(true);
  const listen = await client.listen({ resourceSubscriptions: ["grayboard://boards/stamped"] });
  expect(hosted.activeListens).toBe(1);
  await tick(); await tick(); // the first stamps it; the second is a quiet one
  expect(hosted.activeListens).toBe(1);
  return { time, tick, tickStream, grant, listen };
}
const aliceRoot = async (r: Read = store.repo.read) => (await store.repo.hosted.all(r)).find(r => !r.root_session_id && r.user_id === user.user_id)!;
const ends: [string, (f: Awaited<ReturnType<typeof stampedListen>>) => unknown][] = [
  ["access revoke", ({ time }) => seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(token), OPENCODE_CLIENT, time.now))],
  ["grant revoke", ({ time, grant }) => seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(grant.refreshToken), OPENCODE_CLIENT, time.now))],
  ["sign-out everywhere", () => seed(store.repo, tx => store.repo.sessions.revokeAllForUser(tx, user.user_id))],
  ["disable", () => seed(store.repo, tx => store.repo.users.setDisabled(tx, user.user_id, true))],
  ["access expiry", ({ time }) => { time.now += OAUTH_TTL.access + 1; }],
  ["binding change", () => seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 }); })],
];
// Only the stream timer ticks (the hosted sweep would end an expired session's row itself), and the backstop sits
// past the access TTL, so the expiry case reaches phase A's auth check with a fresh stamp.
for (const [what, end] of ends) test(`#899: a stamped listen ends within a stream tick of ${what}`, async () => {
  const f = await stampedListen(OAUTH_TTL.access * 10);
  await end(f);
  await f.tickStream();
  expect(hosted.activeListens).toBe(0);
  await f.listen.close();
});

test("#899: a failed generation read in phase A leaves every stream to phase B's full check, which closes a revoked one", async () => {
  const f = await stampedListen(3_600_000, true);
  const authPeek = store.repo.authPeek, authRead = store.repo.authRead;
  let full = 0;
  const peekFailing = async () => {
    store.repo.authPeek = () => { throw new Error("generation read failed"); };
    store.repo.authRead = fn => (full++, authRead(fn));
    try { await f.tickStream(); } finally { store.repo.authPeek = authPeek; store.repo.authRead = authRead; }
  };
  // A healthy stream survives: its stamp is fresh, but with no peek its full check runs, and passes.
  await peekFailing();
  expect(full).toBeGreaterThan(0);
  expect(hosted.activeListens).toBe(1);
  await seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(token), OPENCODE_CLIENT, f.time.now));
  await peekFailing();
  expect(hosted.activeListens).toBe(0);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual(["unauthenticated"]);
  await f.listen.close();
});

// #807 P3 A7d: phase B's generation read is authRead's own; a failure there fails the check closed, as a failed token
// read would, and the close row says `failed`.
test("#807 P3 A7d: a failed generation read in phase B's check closes the stream as failed", async () => {
  const f = await stampedListen(3_600_000, true);
  const authPeek = store.repo.authPeek, authRead = store.repo.authRead;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  store.repo.authPeek = () => undefined;
  store.repo.authRead = async () => { throw new Error("generation read failed"); };
  let failures: unknown[][];
  try { await f.tickStream(); failures = logged.mock.calls.filter(args => args.some(a => String(a).includes("mcp.stream"))); }
  finally { store.repo.authPeek = authPeek; store.repo.authRead = authRead; logged.mockRestore(); }
  expect(failures.length).toBe(1);
  expect(hosted.activeListens).toBe(0);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual(["failed"]);
  await f.listen.close();
});

test("#899: a stamped listen ends within a tick of its root's lease lapsing, a deadline no write marks", async () => {
  const f = await stampedListen();
  const root = (await aliceRoot()).session_id;
  // The update's notice makes the next tick a full check, which stamps the new deadline.
  await seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { lease_deadline: f.time.now + 5_000 }); });
  await f.tick(); await f.tick();
  expect(hosted.activeListens).toBe(1);
  f.time.now += 4_999; await f.tick();
  expect(hosted.activeListens).toBe(1);
  // Before the hosted sweep's own timer could end the root, the stream tick ends the listen at once and posts the
  // settle, which ends the root when its async body commits (#807 P3 A6e2).
  f.time.now += 1; await f.tick();
  expect(hosted.activeListens).toBe(0);
  await store.repo.write(() => {});
  expect(await store.repo.hosted.get(store.repo.read, root)).toBeUndefined();
  await f.listen.close();
});

// A board commit hints the listen from the write queue's holder (its afterCommit flush), where a lapsed root's settle
// can't run as an async post: it goes through the queue behind the holder and ends the root (#807 P3 A6e2 audit).
test("a lapsed root's settle from a board commit's hint, inside the write queue's holder, ends the root", async () => {
  const f = await stampedListen();
  const root = (await aliceRoot()).session_id;
  await seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { lease_deadline: f.time.now + 5_000 }); });
  f.time.now += 5_000;
  token = (await issueOAuth(store.repo, oauth.resource, "bob@example.com", ["grayboard:tools"], f.time.now, OPENCODE_CLIENT)).token;
  const bob = await connect();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await bob.callTool({ name: "bind", arguments: { name: "bob-poster", create: true } })).isError).not.toBe(true);
    const posted = await bob.callTool({ name: "board_post", arguments: { board: "stamped", body: "wake the listen" } });
    expect(posted.isError, JSON.stringify(posted.content)).not.toBe(true);
    await untilHosted(() => hosted.activeListens === 0);
    await store.repo.write(() => {});
    expect(await store.repo.hosted.get(store.repo.read, root)).toBeUndefined();
    expect(logged.mock.calls.filter(args => args.some(a => String(a).includes("write queue's holder")))).toEqual([]);
  } finally { logged.mockRestore(); }
  await f.listen.close();
});

test("#899: a write no notice or generation sees reaches a stamped listen at the recheck backstop", async () => {
  const f = await stampedListen(10_000);
  // Raw SQL on the repo's own connection: no hosted notice, no generation move.
  await seed(store.repo, async tx => execOn(tx, "UPDATE hosted_sessions SET bind_gen = bind_gen + 1 WHERE session_id = ?", (await aliceRoot(tx)).session_id));
  f.time.now += 9_999; await f.tick();
  expect(hosted.activeListens).toBe(1);
  f.time.now += 1; await f.tick();
  await untilHosted(() => hosted.activeListens === 0);
  await f.listen.close();
});

// #807 P3 A7h2: a notice that carries no row (here the full reconcile's null) leaves the lives to the full pass, which
// reads their rows on its Tx and judges them in its apply: no stream tick needed, and none before the read.
test("#807 P3 A7h2: a null notice's full pass stops a live whose binding moved, after the pass's read", async () => {
  const f = await stampedListen(3_600_000, true);
  // Raw SQL: the commit sends no notice, so only the pass below can see it.
  await seed(store.repo, async tx => execOn(tx, "UPDATE hosted_sessions SET bind_gen = bind_gen + 1 WHERE session_id = ?", (await aliceRoot(tx)).session_id));
  let during = -1;
  await held("hosted:reconcile:read", () => hosted.sessions.reconcile(), async () => { during = hosted.activeListens; });
  expect(during).toBe(1);
  expect(hosted.activeListens).toBe(0);
  await f.listen.close();
});

// #807 P3 A7h2 audit: the watcher rows are read before the rebuilds, and each rebuild in its own savepoint, so a rebuild
// that throws still lets the pass's apply stop a live whose binding moved.
test("#807 P3 A7h2: a full pass whose rebuild throws still stops a live whose binding moved", async () => {
  const f = await stampedListen(3_600_000, true);
  await seed(store.repo, async tx => execOn(tx, "UPDATE hosted_sessions SET bind_gen = bind_gen + 1 WHERE session_id = ?", (await aliceRoot(tx)).session_id));
  const builds = spyOn(application, "hostedBuildFacts").mockRejectedValue(new Error("build failed"));
  try {
    await hosted.sessions.reconcile();
    expect(builds).toHaveBeenCalled();
  } finally { builds.mockRestore(); }
  expect(hosted.activeListens).toBe(0);
  await f.listen.close();
});

// SQLite: another connection's commit moves data_version, so the auth generation, and the next tick re-reads the row.
// Postgres: the generation moves only on gb_auth, and another pod's hosted_sessions commit sends no in-process notice,
// so it reaches the listen at the recheck backstop, no sooner (docs/architecture.md, docs/server-hosted-mcp.md §1).
test("#899: another connection's commit reaches a stamped listen within a tick (SQLite) or at the recheck backstop (Postgres)", async () => {
  const f = await stampedListen(10_000);
  await store.otherCommit("UPDATE hosted_sessions SET bind_gen = bind_gen + 1 WHERE session_id = ?", (await aliceRoot()).session_id);
  if (TEST_BACKEND === "pg") {
    f.time.now += 9_999; await f.tick();
    expect(hosted.activeListens).toBe(1);
    f.time.now += 1;
  }
  await f.tick();
  await untilHosted(() => hosted.activeListens === 0);
  await f.listen.close();
});

// #807 P3 A7d: `start`'s work holds at `point` until it has been hit `hits` times (or fails after 5 s), then `during`
// runs, then the pause releases. Resolves with `start`'s value once it settles.
async function held<T>(point: string, start: () => Promise<T>, during: () => Promise<void>, hits = 1) {
  const dir = mkdtempSync(join(tmpdir(), "gb-mcp-pause-")), file = join(dir, "release");
  let seen = 0, released = 0;
  const reached = Promise.withResolvers<void>();
  const log = spyOn(console, "error").mockImplementation((message: unknown) => {
    if (message === `[grayboard] test pause hit: ${point}` && ++seen === hits) reached.resolve();
    if (message === `[grayboard] test pause released: ${point}`) released++;
  });
  process.env.BUS_TEST_PAUSE = point; process.env.BUS_TEST_PAUSE_FILE = file;
  const deadline = setTimeout(() => reached.reject(new Error(`pause point ${point} hit ${seen} of ${hits} times in 5 s`)), 5_000);
  try {
    const result = start();
    result.catch(() => {});
    await reached.promise;
    clearTimeout(deadline);
    await during();
    writeFileSync(file, "release");
    const value = await result;
    // A hold off `start`'s own path (a live's re-read) may still be polling: the dir stays until it has passed.
    await until(() => released === seen, 5_000, `every hold at ${point} released`);
    expect(seen).toBe(hits);
    return { value, failures: () => log.mock.calls.filter(args => String(args[0]).includes("mcp.stream")) };
  } finally {
    clearTimeout(deadline);
    writeFileSync(file, "release");
    delete process.env.BUS_TEST_PAUSE; delete process.env.BUS_TEST_PAUSE_FILE;
    log.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
}
// Phase B's full check held at `mcp:stream:check` (after its generation read, before authorize) while a second tick
// overlaps it (skipping it), then `during`.
const heldCheck = (tickStream: () => Promise<void>, during: () => Promise<void>) =>
  held("mcp:stream:check", tickStream, async () => { await tickStream(); await during(); });
const streamClosedReasons = closedReasons;
const revokeAccess = (access: string, at: number) => seed(store.repo, tx => store.repo.oauth.revokeToken(tx, hashToken(access), OPENCODE_CLIENT, at));

test("#807 P3 A7d: a revoke during a held phase-B check stales its stamp: the next tick closes the listen once", async () => {
  const f = await stampedListen(10_000, true);
  f.time.now += 10_000; // past the recheck backstop: the next tick checks in full
  const { failures } = await heldCheck(f.tickStream, () => revokeAccess(token, f.time.now));
  // The check read under the generation before the revoke: its answer stands, linearized before the revoke, and its
  // stamp keeps that generation, so the next tick checks in full and closes the listen.
  expect(hosted.activeListens).toBe(1);
  await f.tickStream();
  expect(hosted.activeListens).toBe(0);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual(["unauthenticated"]);
  expect(failures()).toEqual([]);
  await f.listen.close();
});

test("#807 P3 A7d: a held phase-B check whose live stopped meanwhile acts on nothing", async () => {
  const f = await stampedListen(10_000, true);
  f.time.now += 10_000;
  const { failures } = await heldCheck(f.tickStream, async () => {
    // A binding change stops the live, unaudited; the revoke then refuses the released check.
    await seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 }); });
    expect(hosted.activeListens).toBe(0);
    await revokeAccess(token, f.time.now);
  });
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual([]);
  expect(failures()).toEqual([]);
  await f.listen.close();
});

test("#807 P3 A7d: a held phase-B check of an idle legacy GET that an attach re-selects leaves the GET open", async () => {
  const { time, tickStream } = await clocked(undefined, 10_000, true);
  const grant = await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT);
  const auth = new Headers({ Authorization: `Bearer ${grant.token}` });
  token = grant.token;
  const legacy = await connect("2025-11-25", undefined, auth);
  expect((await legacy.callTool({ name: "board_create", arguments: { name: "attach", purpose: "A7d" } })).isError).not.toBe(true);
  await untilHosted(() => hosted.activeGetStreams === 1);
  await tickStream();
  // The GET's own token is revoked once its client sends a refreshed one. The revoke moves the generation, so the
  // next tick checks the GET in full, under the old token.
  const { access } = await rotateOAuth(store.repo, grant, grant.refreshToken, time.now);
  auth.set("Authorization", `Bearer ${access}`);
  // A POST under the refreshed token re-authorizes the legacy session; the idle GET keeps its old context.
  expect((await legacy.callTool({ name: "board_list", arguments: {} })).isError).not.toBe(true);
  await revokeAccess(grant.token, time.now);
  const { failures } = await heldCheck(tickStream, async () => {
    // The subscribing POST re-selects the idle GET's context under the refreshed token.
    expect(await legacy.subscribeResource({ uri: "grayboard://boards/attach" })).toEqual({});
  });
  // The released check, refused under the old token, is about a context the GET no longer has.
  expect(hosted.activeGetStreams).toBe(1);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual([]);
  expect(failures()).toEqual([]);
  await tickStream();
  expect(hosted.activeGetStreams).toBe(1);
  await legacy.close();
});

// #807 P3 A7d: a legacy GET's check awaits before it takes the stream; the session and the stream are read again after.
test("#807 P3 A7d: a legacy GET whose session the sweep retires while its check awaits answers 404 and opens no stream", async () => {
  const { time, tickStream } = await clocked(undefined, undefined, true);
  const access = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const raw = await rawLegacySession(access);
  const abort = new AbortController();
  const { value: get } = await held("mcp:legacy:get-checked", () => raw.get(abort.signal), async () => {
    await revokeAccess(access, time.now);
    await tickStream();
    expect(hosted.activeLegacySessions).toBe(0);
  });
  expect(get.status).toBe(404);
  expect(hosted.activeGetStreams).toBe(0);
  abort.abort(); await get.body?.cancel().catch(() => {});
});

test("#807 P3 A7d: of two legacy GETs whose checks await together, one takes the stream and the other answers 409", async () => {
  const { time } = await clocked(undefined, undefined, true);
  const access = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const raw = await rawLegacySession(access, meta);
  const aborts = [new AbortController(), new AbortController()];
  const { value: gets } = await held("mcp:legacy:get-checked", () => Promise.all(aborts.map(a => raw.get(a.signal))), async () => {}, 2);
  expect(gets.map(g => g.status).sort()).toEqual([200, 409]);
  expect(hosted.activeGetStreams).toBe(1);
  // The SDK's transport would refuse the second stream too, but a GET that took the session's stream past the
  // recheck would clear it when its refused stream stopped: a later subscription would then join no stream.
  expect((await raw.post("tools/call", { name: "board_create", arguments: { name: "raced", purpose: "A7d" }, _meta: meta })).text).not.toContain("isError\":true");
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/raced", _meta: meta })).text).not.toContain("\"error\"");
  expect(hosted.activeWatches).toBe(1);
  for (const a of aborts) a.abort();
  for (const g of gets) await g.body?.cancel().catch(() => {});
  await raw.delete();
});

// #807 P3 A7h2: a live keeps its creator's rows only when no notice for them came after the read began; a GET whose
// root's binding moved while its check awaited re-reads them once it opens, and stops, with no stream tick.
test("#807 P3 A7h2: a legacy GET whose binding moves while its check awaits re-reads its rows and stops", async () => {
  const { time } = await clocked(undefined, undefined, true);
  const access = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const raw = await rawLegacySession(access, meta);
  expect((await raw.post("tools/call", { name: "board_create", arguments: { name: "moved", purpose: "A7h2" }, _meta: meta })).text).not.toContain("isError\":true");
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/moved", _meta: meta })).text).not.toContain("\"error\"");
  const abort = new AbortController();
  const { value: get } = await held("mcp:legacy:get-checked", () => raw.get(abort.signal), async () => {
    await seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 }); });
  });
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 0);
  abort.abort(); await get.body?.cancel().catch(() => {});
  await raw.delete();
});

// #1196: a moved read whose notice the prune dropped is still re-read: `prunedThrough` past the read's start stands in
// for the notice, so the GET re-reads its rows once it opens and stops, with no check of its own.
test("#1196: a legacy GET whose binding moves, and whose notice the prune drops, while its check awaits re-reads its rows and stops", async () => {
  const { time, tickStream } = await clocked(undefined, undefined, true);
  const access = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const raw = await rawLegacySession(access, meta);
  expect((await raw.post("tools/call", { name: "board_create", arguments: { name: "pruned", purpose: "#1196" }, _meta: meta })).text).not.toContain("isError\":true");
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/pruned", _meta: meta })).text).not.toContain("\"error\"");
  const abort = new AbortController();
  const { value: get } = await held("mcp:legacy:get-checked", () => raw.get(abort.signal), async () => {
    await seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { bind_gen: r.bind_gen + 1 }); });
    // Past the prune interval with no live stamped: the prune drops the root's notice.
    time.now += 30_000; await tickStream();
  });
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 0);
  abort.abort(); await get.body?.cancel().catch(() => {});
  await raw.delete();
});

// #1196: a live's bound starts from its creator's rows, so a root notice during the re-read its moved read queued
// notes into a real pair: a child's live, whose own row the notice leaves, keeps streaming.
test("#1196: a child's legacy GET whose read moved keeps streaming through a root notice during its re-read", async () => {
  const principal = await oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.register(principal, sessionContext(principal, meta), "test-child");
  const childMeta = { "ai.opencode/sessionID": "test-child" };
  const root = await rawLegacySession(token, meta);
  expect((await root.post("tools/call", { name: "board_create", arguments: { name: "child", purpose: "#1196" }, _meta: meta })).text).not.toContain("isError\":true");
  const raw = await rawLegacySession(token, childMeta);
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/child", _meta: childMeta })).text).not.toContain("\"error\"");
  const child = (await store.repo.hosted.all(store.repo.read)).find(r => r.root_session_id)!;
  const touch = (id: string) => seed(store.repo, tx => store.repo.hosted.update(tx, id, { last_seen_at: Date.now() }));
  // The GET's own read is followed by a notice for the child's row: its live re-reads.
  const readRoot = hosted.sessions.readRoot;
  let inject = true, reads = 0;
  const roots = spyOn(hosted.sessions, "readRoot").mockImplementation(async row => {
    const read = await readRoot(row);
    reads++;
    if (inject) { inject = false; await touch(child.session_id); }
    return read;
  });
  const abort = new AbortController();
  try {
    const { value: get } = await held("mcp:live:recheck", () => raw.get(abort.signal), async () => {
      expect(hosted.activeGetStreams).toBe(1);
      await touch(child.root_session_id!);
    });
    expect(get.status).toBe(200);
    await untilHosted(() => reads >= 2);
    await store.repo.write(() => {});
    expect(hosted.activeGetStreams).toBe(1);
    abort.abort(); await get.body?.cancel().catch(() => {});
  } finally { roots.mockRestore(); }
  await raw.delete(); await root.delete();
});

// #1486: a re-read a root notice raced is merged per row: the child's own row, which no notice followed, takes the
// re-read's half (ended), so the child's listen stops on its first re-read, though a root notice races every re-read.
// The stream timer runs only by hand and never does here: the stop is the re-read's own.
test("#1486: a child's listen whose row ended during its read stops on its re-read though root notices race each one", async () => {
  const { time } = await clocked(undefined, undefined, true);
  token = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const principal = await oauth.authenticate(new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}` } }));
  if (principal instanceof Response) throw new Error("fixture authorization failed");
  await hosted.sessions.register(principal, sessionContext(principal, meta), "test-child");
  expect((await (await connect()).callTool({ name: "board_create", arguments: { name: "churn", purpose: "#1486" } })).isError).not.toBe(true);
  const child = (await store.repo.hosted.all(store.repo.read)).find(r => r.root_session_id)!;
  const client = await connect(undefined, undefined, undefined, undefined, { "ai.opencode/sessionID": "test-child" });
  const readRow = hosted.sessions.readRow;
  let armed = false, reads = 0;
  // The child's reads once armed: the first (the listen's own) is followed by the row's end, each later one (a
  // re-read) by a root notice, up to a bound a re-read loop that never merges reaches.
  const rows = spyOn(hosted.sessions, "readRow").mockImplementation(async id => {
    const read = await readRow(id);
    if (!armed || id !== child.session_id) return read;
    reads++;
    if (reads === 1) await seed(store.repo, tx => store.repo.hosted.childEnd(tx, child.session_id, Date.now(), "closed"));
    else if (reads < 20) await seed(store.repo, tx => store.repo.hosted.update(tx, child.root_session_id!, { last_seen_at: Date.now() }));
    return read;
  });
  try {
    const { value: listen } = await held("mcp:authorize:facts", () => client.listen({ resourceSubscriptions: ["grayboard://boards/churn"] }), async () => { armed = true; });
    await untilHosted(() => hosted.activeListens === 0, 5_000);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThan(5);
    await listen.close();
  } finally { rows.mockRestore(); }
});

// #1196: an idle GET a subscription attaches adopts its re-selection's rows only when no notice for them followed
// the selection's start; a notice after its read makes the live re-read them.
test("#1196: an idle legacy GET whose re-selection a notice raced re-reads its rows when a subscription attaches it", async () => {
  const raw = await rawLegacySession(token, meta);
  expect((await raw.post("tools/call", { name: "board_create", arguments: { name: "attached", purpose: "#1196" }, _meta: meta })).text).not.toContain("isError\":true");
  const abort = new AbortController();
  const get = await raw.get(abort.signal);
  expect(get.status).toBe(200);
  expect(hosted.activeGetStreams).toBe(1);
  // Every selection from here is followed by a notice for the root's row: the attach's re-selection among them.
  const snapshot = hosted.sessions.snapshot;
  const snapshots = spyOn(hosted.sessions, "snapshot").mockImplementation(async (...args) => {
    const selected = await snapshot(...args);
    await seed(store.repo, async tx => { const r = await aliceRoot(tx); return store.repo.hosted.update(tx, r.session_id, { last_seen_at: Date.now() }); });
    return selected;
  });
  try {
    const { value: subscribed } = await held("mcp:live:recheck", () => raw.post("resources/subscribe", { uri: "grayboard://boards/attached", _meta: meta }), async () => {});
    expect(subscribed.text).not.toContain("\"error\"");
  } finally { snapshots.mockRestore(); }
  await store.repo.write(() => {});
  expect(hosted.activeGetStreams).toBe(1);
  expect(hosted.activeWatches).toBe(1);
  abort.abort(); await get.body?.cancel().catch(() => {});
  await raw.delete();
});

// #1196: the bound text's facts are read only for a selection a server is built for: a legacy session's creating POST,
// not its later requests or the re-selection an attach makes.
test("#1196: a legacy session reads the bound text's facts for its creating POST alone", async () => {
  const launcher = spyOn(application, "hostedLauncher");
  try {
    const raw = await rawLegacySession(token, meta);
    expect(launcher).toHaveBeenCalledTimes(1);
    expect((await raw.post("tools/call", { name: "board_create", arguments: { name: "facts", purpose: "#1196" }, _meta: meta })).text).not.toContain("isError\":true");
    const abort = new AbortController();
    const get = await raw.get(abort.signal);
    expect(get.status).toBe(200);
    expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/facts", _meta: meta })).text).not.toContain("\"error\"");
    expect(hosted.activeWatches).toBe(1);
    expect(launcher).toHaveBeenCalledTimes(1);
    abort.abort(); await get.body?.cancel().catch(() => {});
    await raw.delete();
  } finally { launcher.mockRestore(); }
});

// #807 P3 A7d: a revoke reaches a legacy GET through two phase-B tasks, its own check and its session's sweep; the
// sweep writes the close row when it retires the session, so the GET gets one whichever settles first.
test("#807 P3 A7d: a revoked legacy GET whose session the sweep retires before its own check settles gets one close row", async () => {
  const { time, tickStream } = await clocked(undefined, undefined, true);
  token = (await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT)).token;
  const legacy = await connect("2025-11-25");
  expect((await legacy.callTool({ name: "board_create", arguments: { name: "swept", purpose: "A7d" } })).isError).not.toBe(true);
  await untilHosted(() => hosted.activeGetStreams === 1);
  await revokeAccess(token, time.now);
  await held("mcp:stream:check", tickStream, () => untilHosted(() => hosted.activeLegacySessions === 0));
  expect(hosted.activeGetStreams).toBe(0);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual(["unauthenticated"]);
  await legacy.close();
});

// #807 P3 A7d: the legacy sweep acts on the session as it stands after its reads: a POST that re-authorized it
// meanwhile (a new principal) leaves it to the next tick, which checks the new principal.
test("#807 P3 A7d: a legacy session a POST re-authorizes while the sweep's reads await is not retired", async () => {
  const { time, tickStream } = await clocked(undefined, undefined, true);
  const grant = await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], time.now, OPENCODE_CLIENT);
  const raw = await rawLegacySession(grant.token);
  const { access } = await rotateOAuth(store.repo, grant, grant.refreshToken, time.now);
  await revokeAccess(grant.token, time.now);
  await held("mcp:legacy:sweep", tickStream, async () => {
    // The sweep read the old token as revoked; a POST under the refreshed one re-authorizes the session meanwhile.
    expect((await raw.post("tools/list", {}, access)).response.status).toBe(200);
  });
  expect(hosted.activeLegacySessions).toBe(1);
  await tickStream();
  expect(hosted.activeLegacySessions).toBe(1);
  await raw.delete();
});

// The oracle (#1497): every Repo method the quiet ticks call must be in QUIET_TICK, so none reads a hosted row or an
// alias hold, and none writes.
test("#899: a quiet tick reads no hosted row or alias hold for a stamped listen or legacy GET", async () => {
  const f = await stampedListen();
  const legacy = await connect("2025-11-25");
  expect(await legacy.subscribeResource({ uri: "grayboard://boards/stamped" })).toEqual({});
  await untilHosted(() => hosted.activeGetStreams === 1);
  await f.tick();
  const calls = repoCalls(store.repo);
  try {
    for (let i = 0; i < 5; i++) { f.time.now += 1000; await f.tick(); }
    // Before #899: every tick read each live's row and root and, for its binding, the root's holds.
    expect(calls.list.length).toBeGreaterThan(0); // the recorder is live: the ticks' auth and board checks call through it
    expect([...new Set(calls.list.map(c => c.method))].filter(m => !QUIET_TICK.has(m))).toEqual([]);
    expect(hosted.activeListens).toBe(1);
    expect(hosted.activeGetStreams).toBe(1);
  } finally { calls.restore(); }
  await f.listen.close();
  await legacy.close();
});

// #807 P3 B5a2: a native live's board visibility, read each stream tick (phase B's `checkBoards`), since membership
// writes move no auth generation and send no notice. `private` is alice's team's board; `bob` stays a member, so he
// can post to it after alice leaves.
async function teamFixture() {
  const clock = await clocked(undefined, 3_600_000, true);
  const grant = await issueOAuth(store.repo, oauth.resource, "alice@example.com", ["grayboard:tools"], clock.time.now, OPENCODE_CLIENT);
  token = grant.token;
  const bob = await issueOAuth(store.repo, oauth.resource, "bob@example.com", ["grayboard:tools"], clock.time.now, OPENCODE_CLIENT);
  const team = await seed(store.repo, async tx => {
    const t = await store.repo.teams.create(tx, "private", grant.authed.user_id);
    await store.repo.teams.addMember(tx, t.id, grant.authed.user_id);
    await store.repo.teams.addMember(tx, t.id, bob.authed.user_id);
    return t;
  });
  const remove = () => seed(store.repo, tx => store.repo.teams.removeMember(tx, team.id, grant.authed.user_id));
  const readd = () => seed(store.repo, tx => store.repo.teams.addMember(tx, team.id, grant.authed.user_id));
  return { ...clock, grant, bob, remove, readd };
}
const boardChecked = "mcp:board:checked";

test("#807 P3 B5a2: a team removal reaches a stamped native listen within a stream tick", async () => {
  const f = await teamFixture();
  const client = await connect();
  expect((await client.callTool({ name: "board_create", arguments: { name: "private", purpose: "B5a2", team: "private" } })).isError).not.toBe(true);
  const listen = await client.listen({ resourceSubscriptions: ["grayboard://boards/private"] });
  await f.tick(); await f.tick(); // the first stamps it; the second is a quiet one, through phase A's board check
  expect(hosted.activeListens).toBe(1);
  await f.remove();
  await f.tickStream();
  expect(hosted.activeListens).toBe(0);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual(["not_found"]);
  await listen.close();
});

test("#807 P3 B5a2: a board a legacy subscribe adds while the stream's board check holds waits for the next tick", async () => {
  const f = await teamFixture();
  const raw = await rawLegacySession(token, meta);
  for (const name of ["first", "second"]) expect((await raw.post("tools/call", { name: "board_create", arguments: { name, purpose: "B5a2" }, _meta: meta })).text).not.toContain("isError\":true");
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/first", _meta: meta })).text).not.toContain("\"error\"");
  const abort = new AbortController();
  const get = await raw.get(abort.signal);
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1);
  await f.tickStream(); await f.tickStream();
  // The check read `first` alone; `second` joins the stream while it holds, read by the subscribe's own checks.
  const { failures } = await held(boardChecked, f.tickStream, async () => {
    expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/second", _meta: meta })).text).not.toContain("\"error\"");
    expect(hosted.activeWatches).toBe(2);
  });
  expect(hosted.activeGetStreams).toBe(1);
  expect(failures()).toEqual([]);
  await f.tickStream();
  expect(hosted.activeGetStreams).toBe(1);
  expect(hosted.activeWatches).toBe(2);
  abort.abort(); await get.body?.cancel().catch(() => {});
  await raw.delete();
});

// A stopped legacy stream prunes its lost boards' registrations (asynchronously, which the next GET awaits), so a
// lost board doesn't refuse every later GET; the other registrations stay. Stopped by phase B's board check, or by
// the watch's own close when a post to the lost board reaches it.
// "(prune held)": the prune holds after its read while the next GET arrives, which waits for it.
for (const stop of ["the stream tick", "the watch's close", "the stream tick (prune held)"] as const) test(`#807 P3 B5a2: a legacy GET after ${stop} stops a lost board's stream opens with the rest`, async () => {
  const f = await teamFixture();
  const raw = await rawLegacySession(token, meta);
  for (const args of [{ name: "open" }, { name: "private", team: "private" }]) expect((await raw.post("tools/call", { name: "board_create", arguments: { ...args, purpose: "B5a2" }, _meta: meta })).text).not.toContain("isError\":true");
  for (const uri of ["grayboard://boards/private", "grayboard://boards/open"]) expect((await raw.post("resources/subscribe", { uri, _meta: meta })).text).not.toContain("\"error\"");
  const first = new AbortController();
  const get = await raw.get(first.signal);
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1 && hosted.activeWatches === 2);
  await f.tickStream(); await f.tickStream();
  await f.remove();
  if (stop === "the stream tick (prune held)") {
    const second = new AbortController();
    const answer = Promise.withResolvers<Response>();
    answer.promise.catch(() => {});
    // `start` settles with the GET, so the pause (in the prune, which no caller awaits) stays until the GET answers.
    await held("mcp:legacy:pruned", () => f.tickStream().then(() => answer.promise), async () => {
      await untilHosted(() => hosted.activeGetStreams === 0);
      first.abort(); await get.body?.cancel().catch(() => {});
      const again = raw.get(second.signal);
      again.then(answer.resolve, answer.reject);
      // The pause forces the overlap; this window only gives a GET that didn't wait the time to answer.
      expect(await Promise.race([again.then(() => "answered", () => "answered"), Bun.sleep(200).then(() => "waiting")])).toBe("waiting");
    });
    const response = await answer.promise;
    expect(response.status).toBe(200);
    await untilHosted(() => hosted.activeGetStreams === 1);
    expect(hosted.activeWatches).toBe(1);
    second.abort(); await response.body?.cancel().catch(() => {});
    await raw.delete();
    return;
  }
  if (stop === "the stream tick") await f.tickStream();
  else {
    const own = token;
    token = f.bob.token;
    try {
      const bob = await connect();
      expect((await bob.callTool({ name: "bind", arguments: { name: "bob-be", create: true } })).isError).not.toBe(true);
      expect((await bob.callTool({ name: "board_post", arguments: { board: "private", body: "after" } })).isError).not.toBe(true);
    }
    finally { token = own; }
  }
  await untilHosted(() => hosted.activeGetStreams === 0);
  first.abort(); await get.body?.cancel().catch(() => {});
  const second = new AbortController();
  const again = await raw.get(second.signal);
  expect(again.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1);
  expect(hosted.activeWatches).toBe(1);
  second.abort(); await again.body?.cancel().catch(() => {});
  await raw.delete();
});

// #1216: forcing tests for B5a2's board-check windows.
// `authorizeFor` reads a legacy GET's registrations after its awaits: a subscribe that lands while the GET's board
// read holds adds a board that read missed, so the GET reads again rather than refusing it.
test("#1216: a board a legacy subscribe registers while a GET's board read holds is read again, and the GET opens with it", async () => {
  await teamFixture();
  const raw = await rawLegacySession(token, meta);
  for (const name of ["first", "second"]) expect((await raw.post("tools/call", { name: "board_create", arguments: { name, purpose: "#1216" }, _meta: meta })).text).not.toContain("isError\":true");
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/first", _meta: meta })).text).not.toContain("\"error\"");
  const abort = new AbortController();
  const { value: get } = await held("mcp:authorize:facts", () => raw.get(abort.signal), async () => {
    // The GET's read covered `first` alone. The subscribe's own checks pass through the same point: unpaused.
    delete process.env.BUS_TEST_PAUSE;
    expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/second", _meta: meta })).text).not.toContain("\"error\"");
  });
  // Read once, the GET would judge `second` unread and refuse it.
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1 && hosted.activeWatches === 2);
  abort.abort(); await get.body?.cancel().catch(() => {});
  await raw.delete();
});

// A stopped stream's prune judged its boards before a subscribe that lands after the board came back: the subscribe
// waits out the prune, so the prune can't delete the registration it makes.
test("#1216: a subscribe after a lost board comes back, while the stopped stream's prune holds, survives the prune", async () => {
  const f = await teamFixture();
  const raw = await rawLegacySession(token, meta);
  for (const args of [{ name: "open" }, { name: "private", team: "private" }]) expect((await raw.post("tools/call", { name: "board_create", arguments: { ...args, purpose: "#1216" }, _meta: meta })).text).not.toContain("isError\":true");
  for (const uri of ["grayboard://boards/private", "grayboard://boards/open"]) expect((await raw.post("resources/subscribe", { uri, _meta: meta })).text).not.toContain("\"error\"");
  const first = new AbortController();
  const get = await raw.get(first.signal);
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1 && hosted.activeWatches === 2);
  await f.tickStream(); await f.tickStream();
  await f.remove();
  const subscribed = Promise.withResolvers<string>();
  subscribed.promise.catch(() => {});
  const second = new AbortController();
  // `start` settles with the subscribe and then the next GET, which waits out the prune: the pause (in the prune,
  // which no caller awaits) stays until the prune has run, whether or not the subscribe waited for it.
  const { value: reopened } = await held("mcp:legacy:pruned", () => f.tickStream().then(() => subscribed.promise).then(() => raw.get(second.signal)), async () => {
    // The prune read `private` as lost; alice rejoins the team and subscribes to it again.
    await untilHosted(() => hosted.activeGetStreams === 0);
    first.abort(); await get.body?.cancel().catch(() => {});
    await f.readd();
    const again = raw.post("resources/subscribe", { uri: "grayboard://boards/private", _meta: meta }).then(r => r.text);
    again.then(subscribed.resolve, subscribed.reject);
    // The pause forces the overlap; this window only gives a subscribe that didn't wait the time to register.
    expect(await Promise.race([again.then(() => "answered", () => "answered"), Bun.sleep(200).then(() => "waiting")])).toBe("waiting");
  });
  expect(await subscribed.promise).not.toContain("\"error\"");
  // The next GET carries both registrations.
  expect(reopened.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1 && hosted.activeWatches === 2);
  second.abort(); await reopened.body?.cancel().catch(() => {});
  await raw.delete();
});

// `checkBoards` judges each uri whose board it read: a subscribe adding an unread board while the check holds leaves
// the read ones judged, so a team removal the read saw stops the stream on that tick.
test("#1216: a team removal stops a legacy stream on the tick whose board check a subscribe to another board overlaps", async () => {
  const f = await teamFixture();
  const raw = await rawLegacySession(token, meta);
  for (const args of [{ name: "open" }, { name: "private", team: "private" }]) expect((await raw.post("tools/call", { name: "board_create", arguments: { ...args, purpose: "#1216" }, _meta: meta })).text).not.toContain("isError\":true");
  expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/private", _meta: meta })).text).not.toContain("\"error\"");
  const abort = new AbortController();
  const get = await raw.get(abort.signal);
  expect(get.status).toBe(200);
  await untilHosted(() => hosted.activeGetStreams === 1 && hosted.activeWatches === 1);
  await f.tickStream(); await f.tickStream();
  // Committed before the tick's read, which sees `private` lost; `open` joins the stream while the check holds.
  await f.remove();
  const { failures } = await held(boardChecked, f.tickStream, async () => {
    expect((await raw.post("resources/subscribe", { uri: "grayboard://boards/open", _meta: meta })).text).not.toContain("\"error\"");
    expect(hosted.activeWatches).toBe(2);
  });
  // Skipping the whole judgement once the uri set changed would leave the stream to the next tick.
  expect(hosted.activeGetStreams).toBe(0);
  await store.repo.write(() => {});
  expect((await streamClosedReasons())).toEqual(["not_found"]);
  expect(failures()).toEqual([]);
  abort.abort(); await get.body?.cancel().catch(() => {});
  await raw.delete();
});
