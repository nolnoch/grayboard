// What plugin.test.ts checked of the server through a server-mode
// `grayboard mcp` child, on the drivers that outlive it (#282): hosted MCP
// sessions for tool, DM and delivery semantics, an application session for
// a multi-alias `as` (#451), and the CLI over /api with sessions seeded by
// those drivers. Plugin-client behaviour (its frames, reconnects, file paths
// and presentation) stays in plugin.test.ts until PR 2 deletes it with the
// client; .claude/tmp/gb282-dispositions/plugin.test.ts.md maps each test.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardPostResult } from "../../src/core/tools.ts";
import type { SendResult } from "../../src/server/application.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { runCli } from "../support/cli.ts";
import { cleanEnv } from "../support/env.ts";
import { board, direct } from "../support/events.ts";
import { HostedToolError } from "../support/hosted_session.ts";
import { TestServer } from "../support/server.ts";

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";
let srv: TestServer;

beforeEach(() => {
  // Inbox polling spends hosted requests.
  srv = new TestServer({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(() => srv.stop());

// A credentials file for `token` and a CLI run under it, as `identity`.
function cli(dir: string) {
  return async (token: string, email: string, identity: string, ...args: string[]) => {
    const creds = join(dir, `${identity}-${email}`);
    writeFileSync(creds, JSON.stringify({ session_token: token, server: srv.base, user_email: email }));
    return runCli(args, { cwd: dir, env: cleanEnv({ HOME: dir, GRAYBOARD_CREDENTIALS: creds, BUS_IDENTITY: identity }) });
  };
}

// The instructions' active-claims sentence is application-level only: a
// hosted bind or initialize composes none yet (hosted.ts boundInstructions'
// empty notices); hub.test.ts's hello_ok notices test covers it.
test("a DM and a post queued while a name was free reach its next session at bind", async () => {
  const be = await srv.hosted(A, "be");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.close();

  const fe = await srv.hosted(B, "fe");
  await fe.call("dm_send", { to: `${A}/be`, body: "queued dm" });
  await fe.call("board_post", { board: "e2e", body: "queued post" });

  const again = await srv.hosted(A, "be");
  await again.next(direct((m) => m.body === "queued dm"));
  await again.next(board((i) => i.kind === "push" && i.post.body === "queued post"));
  await again.none(() => true);
});

test("dm_ack takes a list: unknown ids are reported beside the acked, and all unknown is an error", async () => {
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(B, "fe");
  const ids: number[] = [];
  for (const body of ["a", "b"]) ids.push((await fe.call<SendResult>("dm_send", { to: `${A}/be`, body })).message_id);
  expect(await be.call("dm_ack", { message_id: ids })).toBe("ok");
  expect((await be.call<{ unanswered: unknown[] }>("dm_inbox")).unanswered).toEqual([]);
  const mine = (await be.call<SendResult>("dm_send", { to: `${B}/fe`, body: "mine" })).message_id;
  const c = (await fe.call<SendResult>("dm_send", { to: `${A}/be`, body: "c" })).message_id;
  expect(await be.call("dm_ack", { message_id: [c, mine] })).toMatchObject({ acked: [c], not_found: [mine] });
  await expect(be.call("dm_ack", { message_id: [mine] })).rejects.toThrow(/no message/);
});

// The application's refusal (forbidden, HUMAN_RESERVED's fix) is asserted at
// application level in slack_org.test.ts; hosted bind refuses on its own
// check (hosted.ts), with bad_request and a shorter reason.
test("a bind to the reserved human name is refused and leaves the session unbound", async () => {
  const s = await srv.hosted(A, null);
  await expect(s.bind("human")).rejects.toMatchObject({ code: "bad_request", message: "human is reserved for the trusted bridge" });
  expect(await s.call("whoami")).toHaveProperty("unbound", true);
});

test("grayboard claims reads /api/claims and leaves out boards", async () => {
  const alice = await srv.login(A);
  const bob = await srv.login(B);
  const be = await srv.hosted(A, "be");
  await srv.hosted(B, "fe");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  await be.call("claim_take", { key: "dev:env", board: "e2e", note: "migrating" });
  const r = await fetch(`${srv.base}/api/claims?prefix=dev:`, { headers: { Authorization: `Bearer ${bob}` } });
  expect(await r.json()).toEqual([expect.not.objectContaining({ board: expect.anything() })]);

  const gb = cli(mkdtempSync(join(srv.dir, "grayboard-claims-")));
  const held = await gb(bob, B, "fe", "claims", "--prefix", "dev:");
  expect(held.code).toBe(2);
  expect(held.err).toContain(`dev:env held by ${A}/be until`);
  expect((await gb(alice, A, "be", "claims", "--prefix", "dev:")).code).toBe(0);
  expect((await gb("bogus", B, "fe", "claims", "--prefix", "dev:")).code).toBe(1);
});

test("a CLI command on a refused token says to sign in again", async () => {
  const creds = join(mkdtempSync(join(srv.dir, "gb-creds-")), "credentials");
  writeFileSync(creds, JSON.stringify({ session_token: "stale", server: srv.base, user_email: A }));
  const r = await runCli(["team", "list"], { env: cleanEnv({ GRAYBOARD_CREDENTIALS: creds }) });
  expect(r.code).toBe(1);
  expect(r.err).toContain(
    `Error (unauthenticated): your sign-in isn't valid on ${srv.base} (signed out, expired, revoked, or the server's database was reset). Run: grayboard login --server ${srv.base}`,
  );
});

test("login and logout use GRAYBOARD_CREDENTIALS, not ~/.grayboard", async () => {
  const home = mkdtempSync(join(srv.dir, "gb-home-"));
  const creds = join(mkdtempSync(join(srv.dir, "gb-creds-")), "sub", "credentials");
  const run = async (...args: string[]) => {
    const r = await runCli(args, { env: cleanEnv({ HOME: home, GRAYBOARD_CREDENTIALS: creds }) });
    expect(r.code, r.err).toBe(0);
  };

  await run("login", "--dev", A, "--server", srv.base);
  expect(JSON.parse(readFileSync(creds, "utf8"))).toMatchObject({ server: srv.base, user_email: A });
  expect(existsSync(join(home, ".grayboard"))).toBe(false);

  await run("logout");
  expect(readFileSync(creds, "utf8")).toBe("");
  expect(existsSync(join(home, ".grayboard"))).toBe(false);
});

test("grayboard claim acts as one of your identities; a watching session is woken", async () => {
  const alice = await srv.login(A);
  const bob = await srv.login(B);
  const be = await srv.hosted(A, "be");
  await srv.hosted(B, "fe");
  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const gb = cli(mkdtempSync(join(srv.dir, "grayboard-claim-")));

  const who = JSON.parse((await gb(bob, B, "FE", "--json", "whoami")).out);
  expect(who).toMatchObject({ handle: `${B}/fe`, source: "BUS_IDENTITY", email: B });

  const took = await gb(bob, B, "fe", "claim", "take", "sandbox:sbx-1", "--board", "e2e", "--note", "smoke");
  expect(took.code, took.err).toBe(0);
  expect(await be.call("claim_list")).toMatchObject([{ key: "sandbox:sbx-1", holder: `${B}/fe`, note: "smoke" }]);

  const held = await gb(alice, A, "be", "claim", "take", "sandbox:sbx-1");
  expect(held.code).toBe(2);
  expect(JSON.parse(held.out)).toMatchObject({ ok: false, held_by: `${B}/fe` });

  await be.call("claim_watch", { key: "sandbox:sbx-1" });
  expect((await gb(bob, B, "fe", "claim", "release", "sandbox:sbx-1", "--note", "done")).code).toBe(0);
  await be.next(board((i) => i.kind === "push" && i.post.body === `[release] sandbox:sbx-1 — done cc @${A}/be`));

  const unknown = await gb(alice, A, "nope", "claim", "take", "k");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain(`no session has used "${A}/nope"`);
});

test("attachments: a DM and a post carry uploaded files to their readers, and the audit log binds each to its carrier", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
  const be = await srv.hosted(A, "be");
  const fe = await srv.hosted(B, "fe");
  const sim = await srv.hosted(C, "sim");
  const shotInfo = (id: number) => ({ id, filename: "shot.png", type: "image/png", size: png.length, sha256: sha256Hex(png) });

  const shot = await be.upload("shot.png", png);
  const notes = await be.upload("notes.md", "# notes");
  const sent = await be.call<SendResult>("dm_send", { to: `${B}/fe`, body: "see these", attachment_ids: [shot, notes] });
  expect(sent.attachments).toEqual([shotInfo(shot), { id: notes, filename: "notes.md", type: "text/markdown", size: 7, sha256: sha256Hex(new TextEncoder().encode("# notes")) }]);
  expect((await fe.next(direct((m) => m.body === "see these"))).event.message.attachments).toEqual(sent.attachments);
  expect(await fe.download(shot)).toEqual(png);
  await expect(sim.download(shot)).rejects.toThrow(`no attachment ${shot} on a message or post you can read`);

  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const file = await be.upload("shot.png", png);
  const posted = await be.call<BoardPostResult>("board_post", { board: "e2e", body: "@sim shot", attachment_ids: [file] });
  expect(posted.attachments).toEqual([shotInfo(file)]);
  const pushed = await sim.next(board((i) => i.kind === "push" && i.post.body === "@sim shot"));
  expect(pushed.event.item.kind === "push" && pushed.event.item.post.attachments).toEqual([shotInfo(file)]);
  expect(await sim.download(file)).toEqual(png);

  const bound = (srv.app.db.query("SELECT target, detail FROM access_log WHERE action = 'attachment.bound' ORDER BY id").all() as { target: string; detail: string }[])
    .map((r) => ({ target: r.target, ...JSON.parse(r.detail) }));
  expect(bound).toEqual([
    { target: `attachment:${shot}`, identity: `${A}/be`, message_id: sent.message_id, recipient: `${B}/fe` },
    { target: `attachment:${notes}`, identity: `${A}/be`, message_id: sent.message_id, recipient: `${B}/fe` },
    { target: `attachment:${file}`, identity: `${A}/be`, post_id: posted.post_id, board: "e2e" },
  ]);
});

// hosted twin: #451 (a second alias and `as`)
test("a repeat of a dm_send with `as`, holds unchanged, replays the first result", async () => {
  const be = srv.appSession(await srv.login(A), "be");
  await be.connect();
  await be.bind("ops", { create: true });
  const first = await be.send("be", "as ops", { as: "ops" });
  const retry = await be.send("be", "as ops", { as: "ops" });
  const rows = srv.app.db.query("SELECT id, sender FROM messages WHERE body = 'as ops'").all() as { id: number; sender: string }[];
  expect(rows).toEqual([{ id: first.message_id, sender: `${A}/ops` }]);
  expect(retry).toMatchObject({ message_id: first.message_id, replayed: { ref: { kind: "message", id: first.message_id } } });
});

// hosted twin: #451 (tools-only writes_as). hub.test.ts's tools-only test
// covers its pushes; this is its reads of the name's mail.
test("a tools-only session beside the owner reads the name's mail, and isn't pushed it", async () => {
  const alice = await srv.login(A);
  const owner = srv.appSession(alice, "be");
  const tools = srv.appSession(alice, "be", { push: false });
  await Promise.all([owner.connect(), tools.connect()]);
  const fe = await srv.hosted(B, "fe");
  expect(await fe.call<SendResult>("dm_send", { to: `${A}/be`, body: "hi" })).toMatchObject({ delivered_now: true });
  expect((await tools.inbox()).unanswered.map((m) => m.body)).toEqual(["hi"]);
  expect((await owner.next(direct())).message.body).toBe("hi");
  await tools.none(direct());
});

// A refused write's files are released by the client (the plugin, and
// hosted-core's proxy: hosted_core_proxy.test.ts); the server's half is that
// a refused dm_send or board_post binds none of them, and the release
// route then frees each, audited, its bytes with it.
test("a send or post the server refuses binds none of its uploads; releasing them frees the user's unsent quota", async () => {
  const be = await srv.hosted(A, "be");
  const refused = async (tool: string, args: Record<string, unknown>) => {
    const id = await be.upload("notes.md", "# notes");
    await expect(be.call(tool, { ...args, attachment_ids: [id] })).rejects.toBeInstanceOf(HostedToolError);
    expect(srv.app.db.query("SELECT message_id, post_id FROM attachments WHERE id = ?").get(id)).toEqual({ message_id: null, post_id: null });
    await be.release(id);
  };
  await refused("dm_send", { to: "nobody@example.com/x", body: "x" });
  await refused("board_post", { board: "nope", body: "x" });
  expect(srv.app.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  expect(srv.app.db.query("SELECT COUNT(*) AS n FROM attachment_blobs").get()).toEqual({ n: 0 });
  expect(srv.app.db.query("SELECT action FROM access_log WHERE action LIKE 'attachment.%' ORDER BY id").all()).toEqual([
    { action: "attachment.uploaded" }, { action: "attachment.released" },
    { action: "attachment.uploaded" }, { action: "attachment.released" },
  ]);
});

// hosted twin: #451 (a second alias, `as`), #460 (resend). The plugin
// refuses a lost write's repeat once its holds changed (src/plugin/mcp.ts);
// the server's half is how it matches a repeat: by session, sender and
// arguments, so a bind that leaves the sender alone still replays, a repeat
// under another sender is another write, and resend writes again.
test("a repeat after the session's holds changed replays while its sender is unchanged; another sender or resend writes again", async () => {
  const be = srv.appSession(await srv.login(A), "be");
  await be.connect();
  const first = await be.send("be", "once");
  await be.bind("ops", { create: true });
  expect(await be.send("be", "once")).toMatchObject({ message_id: first.message_id, replayed: { ref: { kind: "message", id: first.message_id } } });
  const asOps = await be.send("be", "once", { as: "ops" });
  expect(asOps).not.toHaveProperty("replayed");
  const resent = await be.send("be", "once", { resend: true });
  expect(resent).not.toHaveProperty("replayed");
  expect((await be.send("be", "once")).replayed?.ref.id).toBe(resent.message_id);
  expect(srv.app.db.query("SELECT sender FROM messages WHERE body = 'once' ORDER BY id").all()).toEqual([
    { sender: `${A}/be` }, { sender: `${A}/ops` }, { sender: `${A}/be` },
  ]);

  await be.call("board_create", { name: "e2e", purpose: "fixtures" });
  const post = await be.call<BoardPostResult>("board_post", { board: "e2e", body: "posted once" });
  expect(await be.call("board_post", { board: "e2e", body: "posted once" })).toMatchObject({ replayed: { ref: { kind: "post", id: post.post_id } } });
  expect(await be.call("board_post", { board: "e2e", body: "posted once", resend: true })).not.toHaveProperty("replayed");
  expect(srv.app.db.query("SELECT COUNT(*) AS n FROM posts WHERE body = 'posted once'").get()).toEqual({ n: 2 });
});

