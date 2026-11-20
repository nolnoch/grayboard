// The seven revoking transactions that end hosted sessions (#807 P3 C10d2-a made each an async savepoint body, since a
// released child's ID now ends through the server's composed end): OAuth's redeemCode and rotateRefresh replays,
// revokeToken, revokePreBuiltinGrants and revokeServiceCredential, users.setDisabled and sessions.revokeAllForUser.
// Each pins, on SQLite, the order of the rows it writes (access_log, the child's bounce, binding events) and that a
// failure inside the end rolls the revocation back with it. Written against the synchronous bodies first and passing
// there unchanged, so the conversion kept both.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken } from "./auth.ts";
import { createApplication } from "./application.ts";
import { openDatabase } from "./db.ts";
import { createHostedSessions, sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import { OAUTH_TTL } from "./oauth-types.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { sessionEndPort } from "./session_end.ts";
import type { Read, Tx } from "./store/tx.ts";
import { seed } from "../../tests/support/seed.ts";

let dir: string, now: number;
let database: ReturnType<typeof openDatabase>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
const resource = "https://grayboard.example/mcp";
const random = () => randomBytes(32).toString("base64url");
const context = (p: OAuthPrincipal, raw = "root") => sessionContext(p, { [OPENCODE_SESSION_META]: raw });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gb-revoke-order-"));
  now = Date.now();
  database = openDatabase(join(dir, "bus.db"), { blobDir: join(dir, "blobs"), sessionEnd: sessionEndPort("team") });
  application = createApplication(database.repo);
  const isAuthorized = (p: OAuthPrincipal, r: Read = database.repo.read) => database.repo.oauth.isGrantActive(r, p.grantId, now);
  hosted = createHostedSessions(application, { now: () => now, isAuthorized });
  await hosted.ready;
});
afterEach(async () => {
  await hosted.close();
  await application.stopExpiry();
  database.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// tests/helpers/oauth.ts issueOAuth's lifecycle, keeping the code's hash so a test can present it again.
async function issue(email: string, clientId = OPENCODE_CLIENT) {
  const repo = database.repo;
  return seed(repo, async (tx: Tx) => {
    const user = await repo.users.upsertByEmail(tx, email, null);
    const binding = { clientId, resource, scopes: ["grayboard:delivery", "grayboard:tools"], redirectUri: "http://127.0.0.1/callback", codeChallenge: random() };
    const request = { ...binding, requestHash: hashToken(random()), browserHash: hashToken(random()), csrfHash: hashToken(random()), stateHash: hashToken(random()), consentSessionHash: null, createdAt: now, expiresAt: now + OAUTH_TTL.request };
    const sessionHash = hashToken(random());
    await repo.oauth.createBrowserSession(tx, { sessionHash, userId: user.id, createdAt: now, expiresAt: now + OAUTH_TTL.browser }, now);
    await repo.oauth.createRequest(tx, request, now);
    await repo.oauth.bindRequestSession(tx, request.requestHash, request.browserHash, sessionHash, now);
    const code = { ...binding, codeHash: hashToken(random()), userId: user.id, createdAt: now, expiresAt: now + OAUTH_TTL.code };
    await repo.oauth.decideRequest(tx, { requestHash: request.requestHash, browserHash: request.browserHash, csrfHash: request.csrfHash, sessionHash, approve: true, code }, now);
    const token = random(), refreshToken = random(), grantId = random();
    const tokens = { ...binding, accessHash: hashToken(token), refreshHash: hashToken(refreshToken), accessExpiresAt: now + OAUTH_TTL.access, refreshExpiresAt: now + OAUTH_TTL.refresh };
    const r = await repo.oauth.redeemCode(tx, { ...binding, codeHash: code.codeHash, grantId, grantExpiresAt: now + OAUTH_TTL.grant, tokens }, now);
    if (r.status !== "ok") throw new Error(`issue: ${r.status}`);
    const principal: OAuthPrincipal = { authed: { user_id: user.id, user_email: user.email, kind: user.kind, session_id: 0 }, clientId, sourceKey: OPENCODE_SESSION_META,
      grantId, accessHash: tokens.accessHash, accessExpiry: tokens.accessExpiresAt, scopes: ["tools", "delivery"] };
    return { principal, binding, tokens, codeHash: code.codeHash, refreshToken, userId: user.id, grantId };
  });
}
type Issued = Awaited<ReturnType<typeof issue>>;

// A hosted root bound to `fe` with one child, and an unread DM from the root to the child, which bounces when the child
// ends. Returns the IDs and the row marks the snapshot reads past.
async function fixture(i: Issued) {
  const p = i.principal;
  await hosted.bind(p, context(p), { name: "fe", create: true });
  await hosted.register(p, context(p), "child");
  const ids = database.db.query<{ session_id: string; root_session_id: string | null }, []>("SELECT session_id, root_session_id FROM hosted_sessions").all();
  const child = ids.find(r => r.root_session_id !== null)!.session_id;
  const root = ids.find(r => r.root_session_id === null)!.session_id;
  await seed(database.repo, tx => database.repo.messages.insert(tx, root, "user", child, "unread before the end", null));
  return { root, child, grant: i.grantId, marks: { audit: 0, msg: 0, bind: 0 } };
}
// Rows past this point are the revocation's (a case's setup writes before it).
function markNow(f: Awaited<ReturnType<typeof fixture>>) {
  const mark = (t: string) => database.db.query<{ m: number | null }, []>(`SELECT max(id) AS m FROM ${t}`).get()!.m ?? 0;
  f.marks = { audit: mark("access_log"), msg: mark("messages"), bind: mark("binding_events") };
}

// The rows written past the marks, IDs named by role, in write order.
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const name = (s: string | null) => s === f.root ? "root" : s === f.child ? "child" : s === f.grant ? "grant" : s;
  return {
    audits: database.db.query<{ action: string; target: string | null }, [number]>("SELECT action, target FROM access_log WHERE id > ? ORDER BY id").all(f.marks.audit)
      .map(r => `${r.action} ${name(r.target)}`),
    bounces: database.db.query<{ sender: string; recipient: string; kind: string }, [number]>("SELECT sender, recipient, kind FROM messages WHERE id > ? ORDER BY id").all(f.marks.msg)
      .map(r => `${r.kind} ${name(r.sender)}->${name(r.recipient)}`),
    bindings: database.db.query<{ session_id: string; name: string; event: string; detail: string | null }, [number]>("SELECT session_id, name, event, detail FROM binding_events WHERE id > ? ORDER BY id").all(f.marks.bind)
      .map(r => `${r.event} ${name(r.session_id)} ${r.name} ${r.detail}`),
    childEnded: database.db.query<{ e: number | null }, [string]>("SELECT ended_at AS e FROM ids WHERE id = ?").get(f.child)!.e !== null,
    hostedRows: database.db.query<{ n: number }, []>("SELECT count(*) AS n FROM hosted_sessions").get()!.n,
  };
}

// What each revocation reaches: its grant revoked, or its user disabled, or its CLI sessions revoked.
const grantRevoked = (id: string) => database.db.query<{ r: number | null }, [string]>("SELECT revoked_at AS r FROM oauth_grants WHERE id = ?").get(id)!.r !== null;
const disabled = (id: number) => database.db.query<{ d: number | null }, [number]>("SELECT disabled_at AS d FROM users WHERE id = ?").get(id)!.d !== null;

type Case = { name: string; setup?: (i: Issued) => Promise<void>; run: (tx: Tx, i: Issued) => Promise<unknown>; revoked: (i: Issued) => boolean };

const replayTokens = (i: Issued) => ({ ...i.tokens, accessHash: hashToken(random()), refreshHash: hashToken(random()) });
const CASES: Case[] = [
  {
    name: "redeemCode replay",
    run: (tx, i) => database.repo.oauth.redeemCode(tx, { ...i.binding, codeHash: i.codeHash, grantId: random(), grantExpiresAt: now + OAUTH_TTL.grant, tokens: replayTokens(i) }, now),
    revoked: i => grantRevoked(i.grantId),
  },
  {
    name: "rotateRefresh replay",
    // A first rotation spends the refresh token; presenting it again is the replay.
    setup: async i => { await seed(database.repo, tx => database.repo.oauth.rotateRefresh(tx, { ...i.binding, refreshHash: hashToken(i.refreshToken), tokens: replayTokens(i) }, now)); },
    run: (tx, i) => database.repo.oauth.rotateRefresh(tx, { ...i.binding, refreshHash: hashToken(i.refreshToken), tokens: replayTokens(i) }, now),
    revoked: i => grantRevoked(i.grantId),
  },
  {
    name: "revokeToken (refresh)",
    run: (tx, i) => database.repo.oauth.revokeToken(tx, hashToken(i.refreshToken), OPENCODE_CLIENT, now),
    revoked: i => grantRevoked(i.grantId),
  },
  {
    name: "revokePreBuiltinGrants",
    setup: async () => { await seed(database.repo, () => { database.db.run("DELETE FROM server_state WHERE key = 'builtin_clients'"); }); },
    run: tx => database.repo.oauth.revokePreBuiltinGrants(tx, [OPENCODE_CLIENT], now),
    revoked: i => grantRevoked(i.grantId),
  },
  {
    name: "revokeServiceCredential",
    // The issued grant becomes a service credential's, as the admin route's addServiceCredential would make one.
    setup: async i => { await seed(database.repo, () => {
      database.db.run(`INSERT INTO service_credentials(client_id, user_id, grant_id, source, token_seconds, created_at) VALUES (?, ?, ?, 'generic', 3600, ?)`, [`svc_${"a".repeat(32)}`, i.userId, i.grantId, now]);
    }); },
    run: tx => database.repo.oauth.revokeServiceCredential(tx, `svc_${"a".repeat(32)}`, now),
    revoked: i => grantRevoked(i.grantId),
  },
  {
    name: "users.setDisabled",
    run: (tx, i) => database.repo.users.setDisabled(tx, i.userId, true),
    revoked: i => disabled(i.userId) && grantRevoked(i.grantId),
  },
  {
    name: "sessions.revokeAllForUser",
    run: (tx, i) => database.repo.sessions.revokeAllForUser(tx, i.userId),
    revoked: i => grantRevoked(i.grantId),
  },
];

// The rows each case writes, recorded from the synchronous bodies (master 5ba5b00f) and unchanged since: the child's
// release and its ID's end (with its bounce to the root) come first, inside the revocation, and the revocation's own
// OAuth audit row last.
const rows = (audits: string[], detail: string) => ({ audits, bounces: ["bounce child->root"], bindings: [`released root you@example.com/fe ${detail}`], childEnded: true, hostedRows: 0 });
const EXPECTED: Record<string, ReturnType<typeof snapshot>> = {
  "redeemCode replay": rows(["hosted.child_released root", "id.ended child", "oauth.code_replay_revoked grant"], "revoked"),
  "rotateRefresh replay": rows(["hosted.child_released root", "id.ended child", "oauth.refresh_replay_revoked grant"], "revoked"),
  "revokeToken (refresh)": rows(["hosted.child_released root", "id.ended child", "oauth.revoked grant"], "revoked"),
  "revokePreBuiltinGrants": rows(["hosted.child_released root", "id.ended child", "oauth.builtin_client_grant_revoked grant"], "revoked"),
  "revokeServiceCredential": rows(["hosted.child_released root", "id.ended child"], "revoked"),
  "users.setDisabled": rows(["hosted.child_released root", "id.ended child"], "disabled"),
  "sessions.revokeAllForUser": rows(["hosted.child_released root", "id.ended child"], "revoked"),
};

for (const c of CASES) {
  test(`${c.name}: rows in today's order`, async () => {
    const i = await issue("you@example.com");
    const f = await fixture(i);
    await c.setup?.(i);
    markNow(f);
    await seed(database.repo, tx => c.run(tx, i));
    expect(c.revoked(i)).toBe(true);
    expect(snapshot(f)).toEqual(EXPECTED[c.name]!);
  });

  test(`${c.name}: a failure inside the end rolls the revocation back`, async () => {
    const i = await issue("you@example.com");
    const f = await fixture(i);
    await c.setup?.(i);
    markNow(f);
    const before = snapshot(f);
    await seed(database.repo, () => {
      database.db.run(`CREATE TRIGGER fail_end BEFORE UPDATE OF ended_at ON ids WHEN NEW.ended_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected end failure'); END`);
    });
    await expect(seed(database.repo, tx => c.run(tx, i))).rejects.toThrow("injected end failure");
    await seed(database.repo, () => { database.db.run("DROP TRIGGER fail_end"); });
    expect(c.revoked(i)).toBe(false);
    expect(disabled(i.userId)).toBe(false);
    expect(snapshot(f)).toEqual(before);
    expect(before).toMatchObject({ audits: [], bounces: [], childEnded: false, hostedRows: 2 });
  });

  // The method's own savepoint, not the caller's transaction, is what undoes it: a caller that catches the failure and
  // writes on commits its own write and nothing of the revocation.
  test(`${c.name}: a caught failure inside the end leaves nothing of the revocation in a committed body`, async () => {
    const i = await issue("you@example.com");
    const f = await fixture(i);
    await c.setup?.(i);
    markNow(f);
    const before = snapshot(f);
    const state = () => database.db.query<{ key: string }, []>("SELECT key FROM server_state ORDER BY key").all().map(r => r.key);
    const keys = state();
    await seed(database.repo, () => {
      database.db.run(`CREATE TRIGGER fail_end BEFORE UPDATE OF ended_at ON ids WHEN NEW.ended_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected end failure'); END`);
    });
    const caught = await seed(database.repo, async tx => {
      const error = await c.run(tx, i).then(() => null, (e: unknown) => e);
      database.db.run("INSERT INTO server_state(key, value) VALUES ('probe', 1)");
      return error;
    });
    await seed(database.repo, () => { database.db.run("DROP TRIGGER fail_end"); });
    expect(String(caught)).toContain("injected end failure");
    expect(state()).toEqual([...keys, "probe"].sort());
    expect(c.revoked(i)).toBe(false);
    expect(disabled(i.userId)).toBe(false);
    expect(database.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NOT NULL").get(i.userId)!.n).toBe(0);
    expect(snapshot(f)).toEqual(before);
  });
}
