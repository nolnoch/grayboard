// Databases a previous release wrote open under this tree. The release's own
// binaries write through every public write path they have; then this tree
// opens the files and (a) the schema check: every table and column the old
// database had still exists, and each table matches a fresh database's column
// for column (a missing guarded ALTER shows here); (b) what was written reads
// back through this tree's tools. The same for the local Slack bridge's store.
// Per push: the latest release, which carries this tree's version until the
// next bump. GRAYBOARD_UPGRADE_FROM=<tag> picks another (the nightly matrix
// runs every release at or above v1.0.0). Under scripts/e2e.sh each test keeps the files as the
// release left them and as this tree left them in the run dir.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSlackBridge, type BridgeHandle } from "../../src/bridge/slack.ts";
import { Store } from "../../src/bridge/store.ts";
import { FakeSlack } from "./fake_slack.ts";
import { runCli } from "../support/cli.ts";
import { localEnv, serverEnv } from "../support/env.ts";
import { closeSessions, localSession, mcpSession, stopSession, type Session } from "../support/mcp.ts";
import type { DeliveryEvent } from "../../src/server/application.ts";
import { hashToken } from "../../src/server/auth.ts";
import { OAUTH_TTL } from "../../src/server/oauth-types.ts";
import { direct } from "../support/events.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES, HostedSession } from "../support/hosted_session.ts";
import { CLI } from "../support/paths.ts";
import { newer } from "../../src/cli/update.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { keep } from "../support/run_dir.ts";
import { ServerProcess, TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

// The release that writes the files; every test name carries it.
const FROM = process.env.GRAYBOARD_UPGRADE_FROM ?? (await latestRelease());
// A v2.3.0-or-later server serves only hosted MCP: the release's own CLI has
// no session to write through it (#485).
const HOSTED_ONLY = !newer("v2.3.0", FROM);

let rel: ReleaseBinaries;
let dir: string;
let label: string;
let old: ServerProcess | undefined;
let srv: TestServer | undefined;
let slack: FakeSlack | undefined;
let oldBridge: Subprocess | undefined;
let bridge: BridgeHandle | undefined;
// Hosted sessions on the release's server; each closes before it stops.
const releaseHosted: HostedSession[] = [];

beforeAll(async () => {
  rel = await releaseBinaries(FROM);
}, 120_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grayboard-upgrade-"));
});

// Each step runs even if an earlier one throws, so a failure never orphans
// the release's server or loses the run dir's copy; the first error is rethrown.
afterEach(async () => {
  const steps: (() => unknown)[] = [
    () => {
      oldBridge?.kill("SIGKILL");
      oldBridge = undefined;
    },
    async () => {
      const b = bridge;
      bridge = undefined;
      await b?.stop();
    },
    () => closeSessions(),
    () => Promise.all(releaseHosted.splice(0).map((s) => s.close())),
    () => {
      slack?.stop();
      slack = undefined;
    },
    async () => {
      if (old) await stopOld();
    },
    async () => {
      const s = srv;
      srv = undefined;
      await s?.stop();
    },
    () => keep(label, dir),
    () => rmSync(dir, { recursive: true, force: true }),
  ];
  let first: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      first ??= e;
    }
  }
  if (first) throw first;
});

// Stops the release's server, keeping its log beside its database.
async function stopOld(): Promise<void> {
  const o = old!;
  old = undefined;
  await o.stop();
  writeFileSync(join(dir, "old", "server.log"), o.log());
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 2]);

type Column = { type: string; notnull: number; dflt_value: unknown; pk: number };
type Schema = Record<string, Record<string, Column>>;

// Every table's columns, keyed by name: a column added by ALTER sits last,
// so position isn't compared.
function schema(path: string): Schema {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        Object.fromEntries(
          (db.query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(name) as (Column & { name: string })[]).map(
            ({ name: col, ...c }) => [col, c],
          ),
        ),
      ]),
    );
  } finally {
    db.close();
  }
}

function expectUpgraded(before: Schema, upgraded: Schema, fresh: Schema): void {
  for (const [table, cols] of Object.entries(before)) {
    expect(Object.keys(upgraded[table] ?? {}), `${rel.tag} table ${table}`).toEqual(expect.arrayContaining(Object.keys(cols)));
  }
  expect(upgraded).toEqual(fresh);
}

// Tools a session offers, and each one's parameters: an older release may
// lack a write path, and then the test neither writes nor reads it back.
function surface(tools: { name: string; inputSchema: unknown }[]): Map<string, Set<string>> {
  return new Map(tools.map((t) => [t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}))]));
}

// What the write side needs of a release's session: its own `grayboard mcp`
// (local mode, and a server before v2.3.0), or a hosted MCP session (all a
// v2.3.0-or-later server serves, #485).
type Writer = {
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
  tools: () => Promise<Map<string, Set<string>>>;
  // Makes the call with a PNG attached and answers the attachment's id; a
  // tool that takes no files answers undefined, uncalled.
  withFile: (tool: "dm_send" | "board_post", args: Record<string, unknown>) => Promise<number | undefined>;
  // Hands back every item delivered so far as handled, so the read point
  // covers it (a plugin session's client does that as each push lands).
  settle: () => Promise<void>;
  stop: () => Promise<void>;
};

function pluginWriter(s: Session, cwd: string): Writer {
  const tools = async () => surface((await s.c.listTools()).tools);
  return {
    call: (tool, args) => s.call(tool, args),
    tools,
    withFile: async (tool, args) => {
      if (!(await tools()).get(tool)!.has("attachments")) return undefined;
      writeFileSync(join(cwd, "shot.png"), PNG);
      return (await s.call(tool, { ...args, attachments: [join(cwd, "shot.png")] })).attachments[0].id;
    },
    settle: async () => {},
    stop: () => stopSession(s.c),
  };
}

function hostedWriter(s: HostedSession): Writer {
  const tools = async () => surface(await s.native.listTools());
  return {
    call: (tool, args) => s.call(tool, args),
    tools,
    withFile: async (tool, args) => {
      if (!(await tools()).get(tool)!.has("attachment_ids")) return undefined;
      const id = await s.upload("shot.png", PNG);
      await s.call(tool, { ...args, attachment_ids: [id] });
      return id;
    },
    settle: async () => {
      const items = await s.inbox();
      if (items.length) await s.receipt(items.map((item) => item.id));
    },
    stop: () => s.close(),
  };
}

// A built-in client's access token from the release server's own OAuth
// endpoints: authorize, consent and the token exchange. The upstream Google
// sign-in can't be stubbed in another process, so the one row written by
// hand is the browser session that sign-in leaves (oauth_browsers, in the
// shape every hosted release writes it). `email` has signed in (dev login),
// so its user exists.
async function releaseToken(server: ServerProcess, dbPath: string, email: string): Promise<string> {
  const secret = () => randomBytes(32).toString("base64url");
  const session = secret();
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const { id } = db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number };
    const now = Date.now();
    const row = { sessionHash: hashToken(session), userId: id, createdAt: now, expiresAt: now + OAUTH_TTL.browser };
    db.run("INSERT INTO oauth_browsers(hash, user_id, expires_at, data) VALUES (?, ?, ?, ?)", [row.sessionHash, id, row.expiresAt, JSON.stringify(row)]);
  } finally {
    db.close();
  }
  // ServerProcess's public URL: the issuer, and the origin its redirects name.
  const issuer = "http://localhost";
  const cookies = new Map([["gb_oauth_session", session]]);
  const request = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url.replace(issuer, server.base), { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [k, v] = cookie.split(";")[0]!.split("=");
      cookies.set(k!, v!);
    }
    return res;
  };
  const verifier = secret();
  const redirectUri = "http://127.0.0.1:45678/callback";
  const binding = { client_id: HOSTED_CLIENT, redirect_uri: redirectUri, resource: `${issuer}/mcp` };
  const authorize = await request(`${issuer}/oauth/authorize?` + new URLSearchParams({ ...binding, response_type: "code", scope: HOSTED_SCOPES.join(" "), state: secret(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }));
  expect(authorize.status, await authorize.clone().text()).toBe(303);
  const page = await (await request(authorize.headers.get("Location")!)).text();
  const form = { request: /name="request" value="([^"]+)"/.exec(page)?.[1] ?? "", csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "" };
  const decided = await request(`${issuer}/oauth/consent`, { method: "POST", headers: { Origin: issuer }, body: new URLSearchParams({ ...form, decision: "approve" }) });
  expect(decided.status, page).toBe(303);
  const code = new URL(decided.headers.get("Location")!).searchParams.get("code")!;
  const token = await fetch(`${server.base}/oauth/token`, { method: "POST", body: new URLSearchParams({ ...binding, grant_type: "authorization_code", code, code_verifier: verifier }) });
  const answer = (await token.json()) as { access_token?: string };
  expect(token.status, JSON.stringify(answer)).toBe(200);
  return answer.access_token!;
}

// Whether the release's CLI has `grayboard <path...> <command>`.
async function hasCommand(bin: string, command: string, ...path: string[]): Promise<boolean> {
  const help = await runCli([...path, "--help"], { bin, env: localEnv(dir) });
  return new RegExp(`^  ${command}\\b`, "m").test(help.out);
}

// What the old release wrote, for the read-back.
type Written = { root: number; muted: boolean; watched: boolean; inbox: boolean; acked: boolean; queued?: number; attachment?: number; postFile?: number };

// Two agents write through every tool path the release has: a board, a thread,
// a board and a thread mode, a claim and a watch, a status, DMs (one pending,
// one with a file, one acked) and a post with a file. peer_status is written
// for the schema check only: it clears when a session restarts.
async function writeAll(be: Writer, fe: Writer, feHandle: string, beHandle: string): Promise<Written> {
  const tools = await be.tools();
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const root = (await be.call("board_post", { board: "e2e", body: "root" })).post_id as number;
  await fe.call("board_post", { board: "e2e", body: "reply", parent_id: root });
  await fe.call("board_subscribe", { board: "e2e", mode: "digest" });
  const muted = tools.get("board_subscribe")!.has("thread");
  if (muted) await fe.call("board_subscribe", { board: "e2e", thread: root, mode: "off" });
  await be.call("claim_take", { key: "ticket:ENG-1", board: "e2e", note: "upgrade" });
  const w: Written = { root, muted, watched: tools.has("claim_watch"), inbox: tools.has("dm_inbox"), acked: tools.has("dm_ack") };
  if (w.watched) await fe.call("claim_watch", { key: "ticket:ENG-1" });
  if (tools.has("peer_status")) await be.call("peer_status", { text: "soaking" });
  // fe is online, so this is pushed and acked; be leaves it unanswered.
  await fe.call("dm_send", { to: beHandle, body: "question" });
  if (w.acked) {
    const fyi = (await fe.call("dm_send", { to: beHandle, body: "fyi" })).message_id;
    // Early releases name the parameter id.
    await be.call("dm_ack", { [tools.get("dm_ack")!.has("message_id") ? "message_id" : "id"]: fyi });
  }
  const send = tools.get("dm_send")!;
  if (send.has("pending")) w.queued = (await be.call("dm_send", { to: feHandle, body: "queued", pending: true })).message_id;
  w.attachment = await be.withFile("dm_send", { to: feHandle, body: "file" });
  w.postFile = await be.withFile("board_post", { board: "e2e", body: "screenshot" });
  return w;
}

// What the read-back needs of a session, so one read-back serves a plugin
// session (local mode) and a hosted session (the server, #282).
type Reader = {
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>;
  // A push whose text matches arrives.
  hear: (match: (text: string) => boolean) => Promise<void>;
  // No push whose text matches has arrived.
  quiet: (match: (text: string) => boolean) => Promise<void>;
  // The DM `offline` arrives, and it is the only DM pushed.
  onlyDm: (offline: string) => Promise<void>;
  file: (id: number) => Promise<Uint8Array>;
};

function pluginReader(s: Session): Reader {
  return {
    call: (tool, args) => s.call(tool, args),
    hear: async (match) => {
      await until(() => s.pushes.find((p) => match(p.content)), 10_000);
    },
    quiet: async (match) => expect(s.pushes.some((p) => match(p.content))).toBe(false),
    onlyDm: async (offline) => {
      await until(() => s.pushes.find((p) => p.content === offline), 10_000);
      expect(s.pushes.filter((p) => p.meta.message_id !== undefined).map((p) => p.content)).toEqual([offline]);
    },
    file: async (id) => new Uint8Array(readFileSync((await s.call("attachment_get", { id })).path)),
  };
}

// A hosted item's text: a DM's body, a board item's post body.
const textOf = (e: DeliveryEvent) => (e.kind === "direct" ? e.message.body : ((e.item as { post?: { body: string } }).post?.body ?? ""));

function hostedReader(s: HostedSession): Reader {
  return {
    call: (tool, args) => s.call(tool, args),
    hear: async (match) => {
      await s.next((e) => match(textOf(e)), 10_000);
    },
    quiet: (match) => s.none((e) => match(textOf(e))),
    onlyDm: async (offline) => {
      await s.next(direct((m) => m.body === offline), 10_000);
      await s.none(direct());
    },
    file: (id) => s.download(id),
  };
}

async function readAll(be: Reader, fe: Reader, w: Written, beHandle: string, feHandle: string): Promise<void> {
  const thread = await fe.call("board_read", { board: "e2e", thread: w.root });
  expect(thread.posts.map((p: { body: string }) => p.body)).toEqual(["root", "reply"]);
  expect(await fe.call("board_list")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "e2e", purpose: "fixtures", mode: "digest" })]));
  expect(await fe.call("claim_list")).toMatchObject([{ key: "ticket:ENG-1", holder: beHandle, note: "upgrade" }]);
  // The watch reads back as its effect: fe hears the release.
  if (w.watched) {
    await be.call("claim_release", { key: "ticket:ENG-1", note: "done" });
    await fe.hear((t) => t.startsWith("[release] ticket:ENG-1"));
  }
  const history = await be.call("dm_history", { peer: feHandle });
  expect(history.map((m: { body: string }) => m.body)).toContain("question");
  // Acks are what dm_inbox reads; a release without it may not have kept them alike.
  const inbox = await be.call("dm_inbox");
  if (w.inbox) expect(inbox.unanswered.map((m: { body: string }) => m.body)).toContain("question");
  if (w.inbox && w.acked) expect(inbox.unanswered.map((m: { body: string }) => m.body)).not.toContain("fyi");
  if (w.queued) expect(inbox.promised.map((m: { id: number }) => m.id)).toContain(w.queued);
  if (w.attachment) expect(await fe.file(w.attachment)).toEqual(PNG);
  if (w.postFile) expect(await fe.file(w.postFile)).toEqual(PNG);
  // The mute reads back as its effect: with fe in push mode, a new post
  // reaches it and a reply in the muted thread doesn't.
  if (w.muted) {
    await fe.call("board_subscribe", { board: "e2e", mode: "push" });
    await be.call("board_post", { board: "e2e", body: "muted reply", parent_id: w.root });
    await be.call("board_post", { board: "e2e", body: "after the mute" });
    await fe.hear((t) => t.includes("after the mute"));
    await fe.quiet((t) => t.includes("muted reply"));
  }
}

// Read points (#284 AC 5): the DMs each agent was pushed before the upgrade
// stay read, and one sent while it was offline arrives after. `readPoint` and
// `newest` read the release's database beside its live writers (WAL): the
// release records a read point only after the client handled the push.
type Mailbox = { readPoint: (address: string) => number; newest: (address: string) => number };

function mailbox(path: string, readPointSql: string, newestSql: string): Mailbox {
  const one = (sql: string, address: string) => {
    const db = new Database(path, { readonly: true });
    try {
      // No row yet (a release that hasn't written this reader's cursor) is no read point.
      return (db.query(sql).get(address) as { n: number | null } | null)?.n ?? 0;
    } finally {
      db.close();
    }
  };
  return { readPoint: (a) => one(readPointSql, a), newest: (a) => one(newestSql, a) };
}

function hasTable(path: string, name: string): boolean {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  } finally {
    db.close();
  }
}

// Waits until each agent's read point covers what it was delivered, takes
// both offline, and has a third agent DM each of them.
async function sendWhileOffline(m: Mailbox, be: Writer, fe: Writer, sim: () => Promise<Writer>, beHandle: string, feHandle: string): Promise<void> {
  for (const [w, a] of [[be, beHandle], [fe, feHandle]] as const) {
    await until(async () => {
      await w.settle();
      return m.readPoint(a) >= m.newest(a);
    }, 10_000);
  }
  await be.stop();
  await fe.stop();
  const s = await sim();
  await s.call("dm_send", { to: beHandle, body: "while be was out" });
  await s.call("dm_send", { to: feHandle, body: "while fe was out" });
  await s.stop();
}

// After the upgrade: the offline DM arrives, and nothing it follows comes again.
async function expectReadPointsKept(be: Reader, fe: Reader): Promise<void> {
  await be.onlyDm("while be was out");
  await fe.onlyDm("while fe was out");
}

test(`server: a database ${FROM} wrote opens and reads back`, async () => {
  label = "server";
  const dbPath = join(dir, "old", "grayboard.db");
  mkdirSync(join(dir, "old"));
  // Hosted sessions spend hosted requests polling their inbox.
  old = await ServerProcess.start(rel.server, dbPath, { GRAYBOARD_HOSTED_REQUEST_BURST: "10000", GRAYBOARD_HOSTED_REQUEST_PER_SEC: "10000" });
  const alice = await old.login("alice@example.com");
  const bob = await old.login("bob@example.com");
  const signIns: Record<string, string> = { "alice@example.com": alice, "bob@example.com": bob };
  const tokens: Record<string, string> = {};
  if (HOSTED_ONLY) for (const email of Object.keys(signIns)) tokens[email] = await releaseToken(old, dbPath, email);
  const session = async (email: string, identity: string): Promise<Writer> => {
    if (!HOSTED_ONLY) return pluginWriter(await mcpSession({ bin: rel.cli, env: serverEnv(dir, old!.base, signIns[email]!, identity), cwd: dir, args: ["mcp", "--mode", "server"] }), dir);
    const s = new HostedSession(`${old!.base}/mcp`, tokens[email]!, identity);
    releaseHosted.push(s);
    await s.connect();
    return hostedWriter(s);
  };
  const be = await session("alice@example.com", "be");
  const fe = await session("bob@example.com", "fe");
  const w = await writeAll(be, fe, "bob@example.com/fe", "alice@example.com/be");
  const creds = join(dir, "alice-credentials");
  writeFileSync(creds, JSON.stringify({ session_token: alice, server: old.base, user_email: "alice@example.com" }));
  const team = (bin?: string, ...args: string[]) => runCli(["team", ...args], { bin, cwd: dir, env: serverEnv(dir, old!.base, alice, "be", { GRAYBOARD_CREDENTIALS: creds }) });
  const teams = await hasCommand(rel.cli, "add", "team");
  if (teams) {
    for (const args of [["create", "core"], ["add", "core", "bob@example.com"]]) {
      const r = await team(rel.cli, ...args);
      expect(r.code, r.err).toBe(0);
    }
  }
  // A 2.x server keeps read points by address (#284); a 1.x server by identity.
  const byAddress = hasTable(dbPath, "mailbox_cursors");
  const m = mailbox(
    dbPath,
    byAddress
      ? `SELECT last_seen_id AS n FROM mailbox_cursors WHERE address = ?1 AND stream_type = 'direct' AND stream_ref = ?1`
      : `SELECT MAX(last_seen_id) AS n FROM cursors WHERE stream_type = 'direct' AND stream_ref = ?`,
    `SELECT MAX(id) AS n FROM messages WHERE recipient_type = 'user' AND recipient = ?`,
  );
  await sendWhileOffline(m, be, fe, () => session("alice@example.com", "sim"), "alice@example.com/be", "bob@example.com/fe");
  await stopOld();
  keep(`${label}-as-written`, join(dir, "old"));
  const before = schema(dbPath);

  srv = new TestServer({ dbPath, blobDir: join(dir, "old", "blobs"), hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
  // The old sign-ins still hold.
  for (const token of [alice, bob]) expect((await srv.api(token, "GET", "/api/whoami")).status).toBe(200);
  // The read-back is a hosted session's: the names the release wrote bind as they stand.
  const be2 = hostedReader(await srv.hosted("alice@example.com", "be", { create: false }));
  const fe2 = hostedReader(await srv.hosted("bob@example.com", "fe", { create: false }));
  await expectReadPointsKept(be2, fe2);
  await readAll(be2, fe2, w, "alice@example.com/be", "bob@example.com/fe");
  writeFileSync(creds, JSON.stringify({ session_token: alice, server: srv.base, user_email: "alice@example.com" }));
  if (teams) {
    const members = await runCli(["--json", "team", "members", "core"], { cwd: dir, env: serverEnv(dir, srv.base, alice, "be", { GRAYBOARD_CREDENTIALS: creds }) });
    expect(members.out).toContain("bob@example.com");
  }

  const fresh = new TestServer({ dbPath: join(dir, "fresh.db") });
  await fresh.stop();
  expectUpgraded(before, schema(dbPath), schema(join(dir, "fresh.db")));
}, 60_000);

// #282: this tree's server no longer serves `grayboard mcp --mode server` over WebSocket. A 2.x release's
// process learns that at its first frame and exits with the refusal inside 2 s; a 1.x one is refused the
// same way but may only time out (older than 1.10.0 never reads the answer), so for it the contract is that
// no session is registered.
test(`server: ${FROM}'s \`mcp --mode server\` is refused by this tree's server`, async () => {
  label = "refusal";
  srv = new TestServer({ dbPath: join(dir, "grayboard.db") });
  const token = await srv.login("alice@example.com");
  const run = (timeoutMs: number) =>
    runCli(["mcp", "--mode", "server"], { bin: rel.cli, cwd: dir, env: serverEnv(dir, srv!.base, token, "be"), holdStdin: true, timeoutMs });
  if (FROM.startsWith("v1.")) {
    await run(15_000).catch(() => undefined);
  } else {
    const started = Date.now();
    const r = await run(2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no longer serves `grayboard mcp` over WebSocket");
  }
  expect((srv.app.db.prepare(`SELECT COUNT(*) AS n FROM ids`).get() as { n: number }).n).toBe(0);
}, 30_000);

test(`local: a bus ${FROM} wrote opens and reads back`, async () => {
  label = "local";
  const bus = join(dir, "bus");
  mkdirSync(bus);
  const be = pluginWriter(await localSession(bus, "be", { bin: rel.cli }), bus);
  const fe = pluginWriter(await localSession(bus, "fe", { bin: rel.cli }), bus);
  const w = await writeAll(be, fe, "fe", "be");
  const human = await hasCommand(rel.cli, "human");
  if (human) {
    const r = await runCli(["human", "alex"], { bin: rel.cli, cwd: bus, env: localEnv(bus) });
    expect(r.code, r.err).toBe(0);
  }
  const m = mailbox(join(bus, "bus.db"), `SELECT last_seen_id AS n FROM cursors WHERE reader = ?`, `SELECT MAX(id) AS n FROM messages WHERE recipient = ?`);
  await sendWhileOffline(m, be, fe, async () => pluginWriter(await localSession(bus, "sim", { bin: rel.cli }), bus), "be", "fe");
  keep(`${label}-as-written`, bus);
  const before = schema(join(bus, "bus.db"));

  const be2 = pluginReader(await localSession(bus, "be"));
  const fe2 = pluginReader(await localSession(bus, "fe"));
  await expectReadPointsKept(be2, fe2);
  await readAll(be2, fe2, w, "be", "fe");
  if (human) expect((await runCli(["human"], { cwd: bus, env: localEnv(bus) })).out).toContain("alex");
  await closeSessions();

  const fresh = join(dir, "fresh");
  mkdirSync(fresh);
  await stopSession((await localSession(fresh, "be")).c);
  expectUpgraded(before, schema(join(bus, "bus.db")), schema(join(fresh, "bus.db")));
}, 60_000);

// The bridge shipped in v1.2.0.
test.skipIf(newer("v1.2.0", FROM))(`Slack bridge: a store ${FROM} wrote opens and reads back`, async () => {
  label = "slack";
  slack = new FakeSlack({ channel: "G0PRIVATE", owner: "U0OWNER", channelType: "group" });
  const bus = join(dir, "bus");
  mkdirSync(join(bus, "home", ".grayboard"), { recursive: true });
  // Where the release keeps both files by default: ~/.grayboard in the temp HOME.
  const config = join(bus, "home", ".grayboard", "slack.json");
  const store = join(bus, "home", ".grayboard", "slack-bridge.db");
  writeFileSync(config, JSON.stringify({ app_token: "xapp-1-test", bot_token: "xoxb-test", channel: "G0PRIVATE", owner: "U0OWNER", handle: "alex" }));
  chmodSync(config, 0o600);
  const env = localEnv(bus, undefined, { SLACK_API_URL: slack.api });
  const posted = (text: string) => slack!.posts().find((p) => JSON.stringify(p).includes(text));
  const ts = (post: Record<string, any>) => slack!.postTs.get(post)!;

  // The session creates the bus before the bridge opens it: released opens race
  // on a new bus (#170).
  const be = await localSession(bus, "be", { bin: rel.cli });
  const proc = Bun.spawn([rel.cli, "bridge", "slack"], { cwd: bus, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  oldBridge = proc;
  const log = new Response(proc.stderr).text();
  await until(async () => (await be.call("peer_list")).peers.find((p: { handle: string }) => p.handle === "alex"), 10_000);
  // A DM thread and a board thread, each mapped to its Slack thread...
  const q = await be.call("dm_send", { to: "alex", body: "question" });
  const dmTs = ts(await until(() => posted("question")));
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const root = (await be.call("board_post", { board: "e2e", body: "@alex please review" })).post_id as number;
  const boardTs = ts(await until(() => posted("please review")));
  // ...and one outbox item Slack hasn't taken when the release stops.
  slack.failPosts = 1_000;
  await be.call("dm_send", { to: "alex", body: "queued" });
  await until(() => slack!.calls.find((c) => c.method === "chat.postMessage" && JSON.stringify(c.body).includes("queued")));
  proc.kill("SIGTERM");
  expect(await proc.exited, await log).toBe(0);
  oldBridge = undefined;
  writeFileSync(join(bus, "old-bridge.log"), await log);
  await stopSession(be.c);
  keep(`${label}-as-written`, bus);
  const before = schema(store);
  const db = new Database(store, { readonly: true });
  expect((db.query(`SELECT COUNT(*) AS n FROM outbox WHERE done_at IS NULL`).get() as { n: number }).n).toBe(1);
  db.close();

  slack.failPosts = 0;
  const be2 = await localSession(bus, "be");
  bridge = await startSlackBridge({ command: process.execPath, args: [CLI, "mcp", "--mode", "local"] }, { ...env, GRAYBOARD_SLACK_CONFIG: config, GRAYBOARD_SLACK_DB: store });
  // The pending item posts once; replies in the old threads reach be, threaded.
  await until(() => slack!.posts().find((p) => JSON.stringify(p).includes("queued") && slack!.postTs.has(p)));
  slack.say("[] please", { thread_ts: dmTs });
  const dm = await until(() => be2.pushes.find((p) => p.content === "[] please"));
  expect(dm.meta).toMatchObject({ from: "alex", parent_id: String(q.message_id) });
  slack.say("looks good", { thread_ts: boardTs });
  const post = await until(() => be2.pushes.find((p) => p.content === "looks good"));
  expect(post.meta).toMatchObject({ board: "e2e", parent_id: String(root) });
  await bridge.stop();
  bridge = undefined;

  const fresh = join(dir, "fresh-slack.db");
  new Store(fresh).close();
  expectUpgraded(before, schema(store), schema(fresh));
}, 60_000);
