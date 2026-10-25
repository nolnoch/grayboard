import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createApplication, type DeliveryEvent } from "./application.ts";
import { createHostedMcp } from "./mcp.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META, sessionContext } from "./hosted.ts";
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { afterCommit } from "../core/sqlite.ts";

const origin = "https://grayboard.example.com";
let dir: string;
let database: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let oauth: ReturnType<typeof createOAuthServer>;
let mcp: ReturnType<typeof createHostedMcp>;
let principal: OAuthPrincipal;
let token: string;
let recipient: Awaited<ReturnType<typeof application.selectIdentity>>;
let events: DeliveryEvent[];
function context() {
  const routing = sessionContext(principal, { [OPENCODE_SESSION_META]: "root" });
  if (!("id" in routing)) throw new Error("fixture source mapping");
  return routing;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-postcommit-"));
  const path = join(dir, "bus.db");
  database = openDatabase(path, { blobDir: join(dir, "blobs") });
  const issued = issueOAuth(database.repo, `${origin}/mcp`, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), OPENCODE_CLIENT);
  token = issued.token;
  oauth = createOAuthServer(database.repo, { dbPath: path, blobDir: join(dir, "blobs"), httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: origin, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] });
  application = createApplication(database.repo, database.db);
  mcp = createHostedMcp(application, oauth, { trustedOrigin: origin });
  const authenticated = oauth.authenticate(new Request(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } }), ["grayboard:tools"]);
  if (authenticated instanceof Response) throw new Error("fixture authentication");
  principal = authenticated;
  await mcp.sessions.bind(principal, context(), { name: "fe", create: true });
  events = [];
  recipient = await application.selectIdentity(principal.authed, "launcher", { deliver(event) { events.push(event); }, closed() {}, probe: async () => true }, { push: true, launcher: true });
});
afterEach(async () => {
  await mcp.close(); oauth.close(); application.stopExpiry(); database.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function failAudit(action: string) {
  database.db.exec(`CREATE TRIGGER fail_late_audit BEFORE INSERT ON access_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'forced late audit failure'); END`);
}
const delegate = (session: Parameters<typeof application.delegate>[0]) => application.delegate(session, { persona: "researcher", task: "inspect commit boundary", to: "launcher" });

for (const tool of ["dm_send", "delegate"]) test(`${tool}: late hosted audit rollback discards live payload`, async () => {
  failAudit("hosted.write");
  await expect(mcp.sessions.run(principal, context(), tool, session => tool === "delegate" ? delegate(session) : application.send(session, "launcher", "no ghost"))).rejects.toThrow("forced late audit failure");
  expect(application.history(recipient.session)).toEqual([]);
  expect(events).toEqual([]);
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
  expect(application.history(recipient.session)).toEqual([]); expect(events).toEqual([]);
});

test("live sink sees committed message and both delegation audits on a separate connection", async () => {
  const reader = openDatabase(join(dir, "bus.db"), { blobDir: join(dir, "blobs") });
  let visible = false;
  recipient.session.sink.deliver = event => {
    expect(database.db.inTransaction).toBe(false);
    expect(event.kind).toBe("direct");
    expect(reader.repo.messages.history("you@example.com/launcher")).toHaveLength(1);
    expect(reader.db.query("SELECT action FROM access_log WHERE action IN ('hosted.write', 'delegation.requested')").all()).toHaveLength(2);
    visible = true; events.push(event);
  };
  try {
    await mcp.sessions.run(principal, context(), "delegate", delegate);
    expect(visible).toBe(true); expect(events).toHaveLength(1);
  } finally { reader.db.close(); }
});

test("postcommit sink failure cannot fail or roll back a committed native message", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  recipient.session.sink.deliver = () => { throw new Error("closed transport"); };
  try {
    const sent = await mcp.sessions.run(principal, context(), "dm_send", session => application.send(session, "launcher", "durable despite sink"));
    expect(sent.message_id).toBeGreaterThan(0);
    expect(application.history(recipient.session)).toHaveLength(1);
    expect(database.db.query("SELECT action FROM access_log WHERE action='hosted.write'").all()).toHaveLength(1);
    expect(log).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

test("nested savepoint success waits for outer transaction commit; outer rollback discards payload and invalidation", () => {
  let invalidations = 0;
  const unsubscribe = database.repo.hosted.subscribe(() => { invalidations++; });
  try {
    expect(() => database.db.transaction(() => {
      database.repo.hosted.atomic(() => {
        application.send(recipient.session, "launcher", "rolled back nested");
        database.repo.hosted.end(context().id!, "closed", Date.now());
      });
      expect(application.hostedHolder("you@example.com/fe")?.active).toBe(true);
      expect(events).toEqual([]); expect(invalidations).toBe(0);
      throw new Error("outer rollback");
    }).immediate()).toThrow("outer rollback");
    expect(events).toEqual([]); expect(invalidations).toBe(0);
    expect(application.hostedHolder("you@example.com/fe")?.active).toBe(true);
    expect(database.repo.hosted.get(context().id!)).toBeDefined();
    expect(application.history(recipient.session)).toEqual([]);
    database.db.transaction(() => {
      database.repo.hosted.atomic(() => application.send(recipient.session, "launcher", "committed nested"));
      expect(events).toEqual([]); expect(invalidations).toBe(0);
    }).exclusive();
    expect(events).toHaveLength(1); expect(invalidations).toBe(1);
  } finally { unsubscribe(); }
});

test("caught inner rollback discards only inner effects and preserves outer effect ordering", () => {
  const observed: string[] = [];
  database.db.transaction(() => {
    afterCommit(database.db, () => { observed.push("outer-first"); });
    expect(() => database.db.transaction(() => {
      application.send(recipient.session, "launcher", "inner ghost");
      throw new Error("inner rollback");
    }).deferred()).toThrow("inner rollback");
    database.repo.hosted.atomic(() => application.send(recipient.session, "launcher", "outer durable"));
    afterCommit(database.db, () => { observed.push("outer-last"); });
    expect(events).toEqual([]);
  })();
  expect(observed).toEqual(["outer-first", "outer-last"]);
  expect(events).toHaveLength(1); expect(application.history(recipient.session).map(message => message.body)).toEqual(["outer durable"]);
});

test("rolled-back board post neither publishes payload nor invalidates observers or inflight state", async () => {
  application.call(recipient.session, "board_create", { name: "updates", purpose: "test" });
  application.call(recipient.session, "board_subscribe", { board: "updates", mode: "push" });
  const observer = mock(() => {});
  application.observeBoard(recipient.session, "updates", { changed: observer });
  events.length = 0;
  failAudit("hosted.write");
  await expect(mcp.sessions.run(principal, context(), "board_post", session => application.call(session, "board_post", { board: "updates", body: "no ghost post" }))).rejects.toThrow();
  expect(events).toEqual([]); expect(observer).not.toHaveBeenCalled(); expect(recipient.session.inflight.size).toBe(0);
  database.db.exec("DROP TRIGGER fail_late_audit");
  await mcp.sessions.run(principal, context(), "board_post", session => application.call(session, "board_post", { board: "updates", body: "committed post" }));
  expect(events.some(event => event.kind === "board")).toBe(true); expect(observer).toHaveBeenCalled();
});

test("failed SQLite COMMIT discards queued payload and leaves the connection reusable", () => {
  database.db.exec("CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)");
  expect(() => database.db.transaction(() => {
    application.send(recipient.session, "launcher", "commit must fail");
    database.db.run("INSERT INTO commit_child(parent) VALUES (1)");
  }).immediate()).toThrow();
  expect(events).toEqual([]); expect(application.history(recipient.session)).toEqual([]);
  database.db.transaction(() => { application.send(recipient.session, "launcher", "next commit succeeds"); })();
  expect(events).toHaveLength(1);
});

test("a failing postcommit effect does not suppress later effects or retain board inflight phantom state", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const observed: string[] = [];
  try {
    database.repo.hosted.atomic(() => {
      afterCommit(database.db, () => { throw new Error("first failed"); });
      afterCommit(database.db, async () => { throw new Error("async failed"); });
      afterCommit(database.db, () => { observed.push("last delivered"); });
    });
    expect(observed).toEqual(["last delivered"]);
    application.call(recipient.session, "board_create", { name: "updates", purpose: "test" });
    application.call(recipient.session, "board_subscribe", { board: "updates", mode: "push" });
    recipient.session.sink.deliver = () => { throw new Error("board sink failed"); };
    await mcp.sessions.run(principal, context(), "board_post", session => application.call(session, "board_post", { board: "updates", body: "durable post" }));
    expect(recipient.session.inflight.size).toBe(0);
    recipient.session.sink.deliver = event => { events.push(event); };
    application.wake([recipient.session.identityFull]);
    expect(events.some(event => event.kind === "board")).toBe(true);
    expect(log).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
