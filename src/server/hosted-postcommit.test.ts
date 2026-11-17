import { DEFAULT_HELLO_LIMIT, DEFAULT_AUTH_FAIL_LIMIT } from "./rate_limit.ts";
import { AppSession, type AppEvent } from "../../tests/support/app_session.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "./db.ts";
import { createApplication } from "./application.ts";
import { createHostedMcp } from "./mcp.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { afterCommit } from "../core/sqlite.ts";
import { seed } from "../../tests/support/seed.ts";
import type { Tx } from "./store/tx.ts";

const origin = "https://grayboard.example.com";
let dir: string;
let database: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let oauth: ReturnType<typeof createOAuthServer>;
let mcp: ReturnType<typeof createHostedMcp>;
let principal: OAuthPrincipal;
let token: string;
let recipient: AppSession;
let events: AppEvent[];
function context() {
  const routing = sessionContext(principal, { [OPENCODE_SESSION_META]: "root" });
  if (!("id" in routing)) throw new Error("fixture source mapping");
  return routing;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-postcommit-"));
  const path = join(dir, "bus.db");
  database = openDatabase(path, { blobDir: join(dir, "blobs") });
  const issued = await issueOAuth(database.repo, `${origin}/mcp`, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
  token = issued.token;
  oauth = createOAuthServer(database.repo, { dbPath: path, blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: origin, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES });
  application = createApplication(database.repo);
  mcp = createHostedMcp(application, oauth, { trustedOrigin: origin });
  const authenticated = oauth.authenticate(new Request(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } }), ["grayboard:tools"]);
  if (authenticated instanceof Response) throw new Error("fixture authentication");
  principal = authenticated;
  await mcp.sessions.bind(principal, context(), { name: "fe", create: true });
  recipient = new AppSession(application, database.repo, principal.authed, "launcher", { launcher: true });
  await recipient.connect();
  events = recipient.events;
});
afterEach(async () => {
  await mcp.close(); oauth.close(); application.stopExpiry(); database.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function failAudit(action: string) {
  database.db.exec(`CREATE TRIGGER fail_late_audit BEFORE INSERT ON access_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'forced late audit failure'); END`);
}
const delegate = (session: Parameters<typeof application.delegate>[1], tx: Tx) => application.delegate(tx, session, { persona: "researcher", task: "inspect commit boundary", to: "launcher" });

for (const tool of ["dm_send", "delegate"]) test(`${tool}: late hosted audit rollback discards live payload`, async () => {
  failAudit("hosted.write");
  await expect(mcp.sessions.run(principal, context(), tool, (session, tx) => tool === "delegate" ? delegate(session, tx) : application.send(tx, session, "launcher", "no ghost"))).rejects.toThrow("forced late audit failure");
  expect(await application.history(database.repo.read, recipient.session)).toEqual([]);
  expect(events).toEqual([]);
  expect(database.db.query("SELECT * FROM write_receipts").all()).toEqual([]);
  expect(database.db.query("SELECT action FROM access_log WHERE action IN ('request.replayed', 'request.resent', 'delegation.requested')").all()).toEqual([]);
});

test("actual HTTP delegation audit rollback cannot publish a launcher request", async () => {
  failAudit("delegation.requested");
  const response = await mcp.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "Mcp-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "delegate",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: "rollback", method: "tools/call", params: { name: "delegate", arguments: { persona: "researcher", task: "inspect commit boundary", to: "launcher" }, _meta: {
    [OPENCODE_SESSION_META]: "root", "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
  } } }) }));
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(JSON.parse(body)).toMatchObject({ id: "rollback", result: { isError: true, content: [{ type: "text", text: "error: internal error" }] } });
  expect(body).not.toContain("forced late audit");
  expect(await application.history(database.repo.read, recipient.session)).toEqual([]); expect(events).toEqual([]);
});

test("live sink sees committed message and both delegation audits on a separate connection", async () => {
  // A plain read-only connection: a second openDatabase would run the schema step, whose launcher sweep (#521 5)
  // clears the mark AppSession declares without a hosted row.
  const reader = new Database(join(dir, "bus.db"), { readonly: true });
  let visible = false;
  recipient.session.sink.deliver = event => {
    expect(database.db.inTransaction).toBe(false);
    expect(event.kind).toBe("direct");
    expect(reader.query("SELECT id FROM messages WHERE recipient = 'you@example.com/launcher'").all()).toHaveLength(1);
    expect(reader.query("SELECT action FROM access_log WHERE action IN ('hosted.write', 'delegation.requested')").all()).toHaveLength(2);
    visible = true; events.push(event);
  };
  try {
    await mcp.sessions.run(principal, context(), "delegate", delegate);
    expect(visible).toBe(true); expect(events).toHaveLength(1);
  } finally { reader.close(); }
});

test("postcommit sink failure cannot fail or roll back a committed native message", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  recipient.session.sink.deliver = () => { throw new Error("closed transport"); };
  try {
    const sent = await mcp.sessions.run(principal, context(), "dm_send", (session, tx) => application.send(tx, session, "launcher", "durable despite sink"));
    expect(sent.message_id).toBeGreaterThan(0);
    expect(await application.history(database.repo.read, recipient.session)).toHaveLength(1);
    expect(database.db.query("SELECT action FROM access_log WHERE action='hosted.write'").all()).toHaveLength(1);
    expect(log).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test("nested savepoint success waits for outer transaction commit; outer rollback discards payload and invalidation", async () => {
  let invalidations = 0;
  const unsubscribe = database.repo.hosted.subscribe(() => { invalidations++; });
  const id = context().id!;
  // The hub's view of the session (its live holder) changes only after a commit: reconcile closes it then.
  const closed = spyOn(application, "close");
  try {
    await expect(seed(database.repo, async tx => {
      await tx.savepoint(async sp => {
        await application.send(sp, recipient.session, "launcher", "rolled back nested");
        database.repo.hosted.end(sp, context().id!, "closed", Date.now());
      });
      expect(closed).not.toHaveBeenCalled();
      expect(events).toEqual([]); expect(invalidations).toBe(0);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(events).toEqual([]); expect(invalidations).toBe(0);
    expect(closed).not.toHaveBeenCalled();
    expect(database.repo.hosted.get(database.repo.read, context().id!)).toBeDefined();
    expect(await application.history(database.repo.read, recipient.session)).toEqual([]);
    // A touch alone tells nothing (#399); an ended row tells, after the outer commit.
    await seed(database.repo, async tx => {
      await tx.savepoint(async sp => { await application.send(sp, recipient.session, "launcher", "committed nested"); database.repo.hosted.touch(sp, id, Date.now()); });
      expect(events).toEqual([]); expect(invalidations).toBe(0);
    });
    expect(events).toHaveLength(1); expect(invalidations).toBe(0);
    await seed(database.repo, async tx => {
      await tx.savepoint(sp => database.repo.hosted.end(sp, id, "closed", Date.now()));
      expect(invalidations).toBe(0);
    });
    expect(invalidations).toBe(1);
    expect(closed).toHaveBeenCalled();
  } finally { unsubscribe(); closed.mockRestore(); }
});

test("caught inner rollback discards only inner effects and preserves outer effect ordering", async () => {
  const observed: string[] = [];
  await seed(database.repo, async tx => {
    afterCommit(database.db, () => { observed.push("outer-first"); });
    await expect(tx.savepoint(async sp => {
      await application.send(sp, recipient.session, "launcher", "inner ghost");
      throw new Error("inner rollback");
    })).rejects.toThrow("inner rollback");
    await tx.savepoint(sp => application.send(sp, recipient.session, "launcher", "outer durable"));
    afterCommit(database.db, () => { observed.push("outer-last"); });
    expect(events).toEqual([]);
  });
  expect(observed).toEqual(["outer-first", "outer-last"]);
  expect(events).toHaveLength(1); expect((await application.history(database.repo.read, recipient.session)).map(message => message.body)).toEqual(["outer durable"]);
});

test("rolled-back board post neither publishes payload nor invalidates observers or inflight state", async () => {
  await seed(database.repo, async tx => {
    await application.call(tx, recipient.session, "board_create", { name: "updates", purpose: "test" });
    await application.call(tx, recipient.session, "board_subscribe", { board: "updates", mode: "push" });
  });
  const observer = mock(() => {});
  application.observeBoard(recipient.session, "updates", { changed: observer });
  events.length = 0;
  failAudit("hosted.write");
  await expect(mcp.sessions.run(principal, context(), "board_post", (session, tx) => application.call(tx, session, "board_post", { board: "updates", body: "no ghost post" }))).rejects.toThrow();
  expect(events).toEqual([]); expect(observer).not.toHaveBeenCalled(); expect(recipient.session.inflight.size).toBe(0);
  database.db.exec("DROP TRIGGER fail_late_audit");
  await mcp.sessions.run(principal, context(), "board_post", (session, tx) => application.call(tx, session, "board_post", { board: "updates", body: "committed post" }));
  expect(events.some(event => event.kind === "board")).toBe(true); expect(observer).toHaveBeenCalled();
});

test("failed SQLite COMMIT discards queued payload and leaves the connection reusable", async () => {
  database.db.exec("CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)");
  await expect(seed(database.repo, async tx => {
    await application.send(tx, recipient.session, "launcher", "commit must fail");
    database.db.run("INSERT INTO commit_child(parent) VALUES (1)");
  })).rejects.toThrow();
  expect(events).toEqual([]); expect(await application.history(database.repo.read, recipient.session)).toEqual([]);
  await seed(database.repo, tx => application.send(tx, recipient.session, "launcher", "next commit succeeds"));
  expect(events).toHaveLength(1);
});

test("a failing postcommit effect does not suppress later effects or retain board inflight phantom state", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const observed: string[] = [];
  try {
    await seed(database.repo, tx => {
      afterCommit(database.db, () => { throw new Error("first failed"); });
      afterCommit(database.db, async () => { throw new Error("async failed"); });
      afterCommit(database.db, () => { observed.push("last delivered"); });
    });
    expect(observed).toEqual(["last delivered"]);
    await seed(database.repo, async tx => {
      await application.call(tx, recipient.session, "board_create", { name: "updates", purpose: "test" });
      await application.call(tx, recipient.session, "board_subscribe", { board: "updates", mode: "push" });
    });
    recipient.session.sink.deliver = () => { throw new Error("board sink failed"); };
    await mcp.sessions.run(principal, context(), "board_post", (session, tx) => application.call(tx, session, "board_post", { board: "updates", body: "durable post" }));
    expect(recipient.session.inflight.size).toBe(0);
    recipient.session.sink.deliver = event => { events.push(event); };
    application.wake([recipient.session.identityFull]);
    expect(events.some(event => event.kind === "board")).toBe(true);
    expect(log).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

// #452: a refusal thrown inside `hosted.run`'s transaction rolls its audit row back with the call, so the row is written after the unwind.
const refusals = () => database.db.query("SELECT actor, target, detail FROM access_log WHERE action = 'delegation.refused'").all() as { actor: string; target: string; detail: string }[];
const refused = (request: Parameters<typeof application.delegate>[2]) => mcp.sessions.run(principal, context(), "delegate", (session, tx) => application.delegate(tx, session, request));

test("hosted delegate: an unresolvable `to` leaves its refusal audit row", async () => {
  await expect(refused({ persona: "researcher", task: "x", to: "nobody-here" })).rejects.toThrow();
  expect(refusals()).toHaveLength(1);
  expect(refusals()[0]).toMatchObject({ actor: "you@example.com" });
  expect(refusals()[0]!.target).toBe("you@example.com/fe");
  expect(JSON.parse(refusals()[0]!.detail)).toMatchObject({ to: "nobody-here" });
});

test("hosted delegate: a successful delegation leaves no refusal row", async () => {
  await refused({ persona: "researcher", task: "x", to: "launcher" });
  expect(refusals()).toEqual([]);
});

test("hosted delegate: a failing refusal-audit write does not mask the refusal", async () => {
  failAudit("delegation.refused");
  const error = spyOn(console, "error").mockImplementation(() => {});
  await expect(refused({ persona: "researcher", task: "x", to: "nobody-here" })).rejects.toThrow(/nobody-here|resolve|no /i);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test("hosted delegate: a resolution refusal (explicit non-launcher target) leaves its audit row", async () => {
  await expect(refused({ persona: "researcher", task: "x", to: "fe" })).rejects.toThrow();
  expect(refusals()).toHaveLength(1);
});

test("hosted delegate: a refused send (oversize task) leaves its audit row", async () => {
  await expect(refused({ persona: "researcher", task: "x".repeat(2_000_000), to: "launcher" })).rejects.toThrow();
  expect(refusals()).toHaveLength(1);
});
