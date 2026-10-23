// Databases a previous release wrote open under this tree. The release's own
// binaries write through every public write path they have; then this tree
// opens the files and (a) the schema check: every table and column the old
// database had still exists, and each table matches a fresh database's column
// for column (a missing guarded ALTER shows here); (b) what was written reads
// back through this tree's tools. The same for the local Slack bridge's store.
// Per push: the latest release, which carries this tree's version until the
// next bump. GRAYBOARD_UPGRADE_FROM=<tag> picks another (the nightly matrix
// runs every v1.x tag). Under scripts/e2e.sh each test keeps the files as the
// release left them and as this tree left them in the run dir.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSlackBridge, type BridgeHandle } from "../../src/bridge/slack.ts";
import { Store } from "../../src/bridge/store.ts";
import { FakeSlack } from "./fake_slack.ts";
import { runCli } from "../support/cli.ts";
import { localEnv, serverEnv } from "../support/env.ts";
import { closeSessions, localSession, mcpSession, stopSession, type Session } from "../support/mcp.ts";
import { CLI } from "../support/paths.ts";
import { newer } from "../../src/cli/update.ts";
import { latestRelease, releaseBinaries, type ReleaseBinaries } from "../support/releases.ts";
import { keep } from "../support/run_dir.ts";
import { ServerProcess, TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";

// The release that writes the files; every test name carries it.
const FROM = process.env.GRAYBOARD_UPGRADE_FROM ?? (await latestRelease());

let rel: ReleaseBinaries;
let dir: string;
let label: string;
let old: ServerProcess | undefined;
let srv: TestServer | undefined;
let slack: FakeSlack | undefined;
let oldBridge: Subprocess | undefined;
let bridge: BridgeHandle | undefined;

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
    () => {
      slack?.stop();
      slack = undefined;
    },
    async () => {
      if (old) await stopOld();
    },
    () => {
      srv?.stop();
      srv = undefined;
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

// Tools the session offers, and each one's parameters: an older release may
// lack a write path, and then the test neither writes nor reads it back.
async function surface(s: Session): Promise<Map<string, Set<string>>> {
  const { tools } = await s.c.listTools();
  return new Map(tools.map((t) => [t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}))]));
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
async function writeAll(be: Session, fe: Session, feHandle: string, beHandle: string, cwd: string): Promise<Written> {
  const tools = await surface(be);
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
  if (send.has("attachments")) {
    writeFileSync(join(cwd, "shot.png"), PNG);
    w.attachment = (await be.call("dm_send", { to: feHandle, body: "file", attachments: [join(cwd, "shot.png")] })).attachments[0].id;
  }
  if (tools.get("board_post")!.has("attachments")) {
    writeFileSync(join(cwd, "shot.png"), PNG);
    w.postFile = (await be.call("board_post", { board: "e2e", body: "screenshot", attachments: [join(cwd, "shot.png")] })).attachments[0].id;
  }
  return w;
}

async function readAll(be: Session, fe: Session, w: Written, beHandle: string, feHandle: string): Promise<void> {
  const thread = await fe.call("board_read", { board: "e2e", thread: w.root });
  expect(thread.posts.map((p: { body: string }) => p.body)).toEqual(["root", "reply"]);
  expect(await fe.call("board_list")).toEqual(expect.arrayContaining([expect.objectContaining({ name: "e2e", purpose: "fixtures", mode: "digest" })]));
  expect(await fe.call("claim_list")).toMatchObject([{ key: "ticket:ENG-1", holder: beHandle, note: "upgrade" }]);
  // The watch reads back as its effect: fe hears the release.
  if (w.watched) {
    await be.call("claim_release", { key: "ticket:ENG-1", note: "done" });
    await until(() => fe.pushes.find((p) => p.content.startsWith("[release] ticket:ENG-1")));
  }
  const history = await be.call("dm_history", { peer: feHandle });
  expect(history.map((m: { body: string }) => m.body)).toContain("question");
  // Acks are what dm_inbox reads; a release without it may not have kept them alike.
  const inbox = await be.call("dm_inbox");
  if (w.inbox) expect(inbox.unanswered.map((m: { body: string }) => m.body)).toContain("question");
  if (w.inbox && w.acked) expect(inbox.unanswered.map((m: { body: string }) => m.body)).not.toContain("fyi");
  if (w.queued) expect(inbox.promised.map((m: { id: number }) => m.id)).toContain(w.queued);
  if (w.attachment) {
    const saved = await fe.call("attachment_get", { id: w.attachment });
    expect(new Uint8Array(readFileSync(saved.path))).toEqual(PNG);
  }
  if (w.postFile) {
    const saved = await fe.call("attachment_get", { id: w.postFile });
    expect(new Uint8Array(readFileSync(saved.path))).toEqual(PNG);
  }
  // The mute reads back as its effect: with fe in push mode, a new post
  // reaches it and a reply in the muted thread doesn't.
  if (w.muted) {
    await fe.call("board_subscribe", { board: "e2e", mode: "push" });
    await be.call("board_post", { board: "e2e", body: "muted reply", parent_id: w.root });
    await be.call("board_post", { board: "e2e", body: "after the mute" });
    await until(() => fe.pushes.find((p) => p.content.includes("after the mute")));
    expect(fe.pushes.some((p) => p.content.includes("muted reply"))).toBe(false);
  }
}

test(`server: a database ${FROM} wrote opens and reads back`, async () => {
  label = "server";
  const dbPath = join(dir, "old", "grayboard.db");
  mkdirSync(join(dir, "old"));
  old = await ServerProcess.start(rel.server, dbPath);
  const alice = await old.login("alice@example.com");
  const bob = await old.login("bob@example.com");
  const session = (base: string, token: string, identity: string, bin?: string) =>
    mcpSession({ bin, env: serverEnv(dir, base, token, identity), cwd: dir, args: ["mcp", "--mode", "server"] });
  const be = await session(old.base, alice, "be", rel.cli);
  const fe = await session(old.base, bob, "fe", rel.cli);
  const w = await writeAll(be, fe, "bob@example.com/fe", "alice@example.com/be", dir);
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
  await stopSession(be.c);
  await stopSession(fe.c);
  await stopOld();
  keep(`${label}-as-written`, join(dir, "old"));
  const before = schema(dbPath);

  srv = new TestServer({ dbPath, blobDir: join(dir, "old", "blobs") });
  // The old sign-ins still hold.
  await readAll(await srv.session(alice, "be"), await srv.session(bob, "fe"), w, "alice@example.com/be", "bob@example.com/fe");
  writeFileSync(creds, JSON.stringify({ session_token: alice, server: srv.base, user_email: "alice@example.com" }));
  if (teams) {
    const members = await runCli(["--json", "team", "members", "core"], { cwd: dir, env: serverEnv(dir, srv.base, alice, "be", { GRAYBOARD_CREDENTIALS: creds }) });
    expect(members.out).toContain("bob@example.com");
  }

  const fresh = new TestServer({ dbPath: join(dir, "fresh.db") });
  fresh.stop();
  expectUpgraded(before, schema(dbPath), schema(join(dir, "fresh.db")));
}, 60_000);

test(`local: a bus ${FROM} wrote opens and reads back`, async () => {
  label = "local";
  const bus = join(dir, "bus");
  mkdirSync(bus);
  const be = await localSession(bus, "be", { bin: rel.cli });
  const fe = await localSession(bus, "fe", { bin: rel.cli });
  const w = await writeAll(be, fe, "fe", "be", bus);
  const human = await hasCommand(rel.cli, "human");
  if (human) {
    const r = await runCli(["human", "alex"], { bin: rel.cli, cwd: bus, env: localEnv(bus) });
    expect(r.code, r.err).toBe(0);
  }
  await stopSession(be.c);
  await stopSession(fe.c);
  keep(`${label}-as-written`, bus);
  const before = schema(join(bus, "bus.db"));

  await readAll(await localSession(bus, "be"), await localSession(bus, "fe"), w, "be", "fe");
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
