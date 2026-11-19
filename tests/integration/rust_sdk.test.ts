// The Rust SDK's example (sdk/rust/grayboard/examples/roundtrip.rs) against a
// real server over HTTP, as a service's queue worker (#929 stage 3 and
// criterion 4; docs/sdk-rust.md §2, §5): an admin creates the service and adds a
// credential through the admin routes; the example mints its own run token with
// that credential (client_credentials, no browser), binds as the service,
// subscribes to the service's queue board in push mode and opens its delivery
// stream; a user holding service_invoke posts a work item and another session of
// the service sends it a DM; the example takes both from the stream, receipts
// them, replies in the item's thread, dm_acks the DM, ends and revokes its token.
// Asserted on server state, not the example's output. Cargo isn't on dev boxes or
// in the pre-push hook, so this runs only when GRAYBOARD_RUST_EXAMPLE names the
// built example; `scripts/e2e.sh rust-sdk` builds it and sets it.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { HostedSession } from "../support/hosted_session.ts";
import { hostedServer, type HostedServer } from "../support/hosted_oauth.ts";
import { until } from "../support/until.ts";

const example = process.env.GRAYBOARD_RUST_EXAMPLE;
const EMAIL = "alice@example.com", ROOT = "root@example.com", SVC = "ingest";
const SESSION = "rust-roundtrip-1";
const RUST = `${SVC}/w-1`;

if (!example) console.log("rust_sdk: skipped (set GRAYBOARD_RUST_EXAMPLE to the built roundtrip example, or run scripts/e2e.sh rust-sdk)");

let srv: HostedServer | undefined;
const sessions: HostedSession[] = [];
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(s => s.close()));
  await srv?.stop();
});

test.skipIf(!example)("the Rust roundtrip example mints its own token as a service and works a queue item and a DM from its delivery stream", async () => {
  expect(existsSync(example!)).toBe(true);
  srv = hostedServer({ admins: [ROOT] }, EMAIL);
  const s = srv;
  const db = s.app.db;
  const rows = <T>(sql: string, ...args: (string | number)[]) => db.query(sql).all(...args) as T[];
  const root = await s.login(ROOT);
  await s.login(EMAIL);
  const admin = async (path: string, body: unknown, status = 201) => {
    const r = await s.api(root, "POST", path, body);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    return r.body as Record<string, any>;
  };
  await admin("/api/admin/services", { name: SVC, owners: [EMAIL] });
  // Two credentials: the example's, and the one the TS session of the service mints with, so the example's tokens are told apart.
  const rust = await admin("/api/admin/services/credentials", { service: SVC });
  const other = await admin("/api/admin/services/credentials", { service: SVC });
  expect(rust.source).toBe("generic");
  await admin("/api/admin/roles/grant", { role: "service_invoke", principal: EMAIL, scope: SVC });

  // The service's other session creates its queue board (so the board is the service's) and later sends the DM.
  const minted = await fetch(`${s.base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${other.client_id}:${other.client_secret}`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  expect(minted.status).toBe(200);
  const svcPeer = new HostedSession(`${s.base}/mcp`, ((await minted.json()) as { access_token: string }).access_token, "w-0", { delivery: false });
  sessions.push(svcPeer);
  await svcPeer.connect();
  await svcPeer.call("board_create", { name: "work", purpose: "rust sdk queue", kind: "queue" });
  const invoker = await s.hosted(EMAIL, "ts-peer");

  const env: Record<string, string | undefined> = { ...process.env, GRAYBOARD_URL: s.resource, GRAYBOARD_ISSUER: s.issuer, GRAYBOARD_CLIENT_ID: rust.client_id, GRAYBOARD_CLIENT_SECRET: rust.client_secret, GRAYBOARD_SESSION: SESSION };
  delete env.GRAYBOARD_RUN_TOKEN;
  const run = Bun.spawn([example!, "w-1", "work"], { env, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => run.kill(), 60_000);
  const output = Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);

  // Post only once the Rust session is subscribed and holds an open lease, so the item reaches it through its stream.
  // Its session ID arrived under the generic key (the credential's source) and its grant is the example's credential.
  await until(() => rows(`SELECT 1 FROM subscriptions WHERE board = 'work' AND handle = ? AND mode = 'push'`, RUST).length === 1
    && rows(`SELECT 1 FROM hosted_sessions WHERE source_session_id = ? AND client_id = ? AND lease_deadline IS NOT NULL`, SESSION, rust.client_id).length === 1, 30_000, "the Rust session subscribed with an open lease");
  const posted = await invoker.call<{ post_id: number }>("board_post", { board: "work", body: "work item" });
  const key = `queue:work:${posted.post_id}`;
  expect(rows(`SELECT holder FROM claims WHERE key = ?`, key)).toEqual([{ holder: RUST }]);
  const sent = await svcPeer.call<{ message_id: number }>("dm_send", { to: RUST, body: "a direct message" });

  const [code, out, err] = await output;
  clearTimeout(killer);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain(`acked ${sent.message_id}`);
  expect(out).toContain("revoked the run token");
  expect(out).not.toContain(rust.client_secret);

  // The reply is in the item's thread, written as the service's name, and released the queue claim.
  expect(rows(`SELECT author, body FROM posts WHERE parent_id = ?`, posted.post_id)).toEqual([{ author: RUST, body: "done" }]);
  expect(rows(`SELECT holder FROM claims WHERE key = ?`, key)).toEqual([]);
  // The DM was acked by its reader.
  expect(rows(`SELECT reader FROM dm_acks WHERE message_id = ?`, sent.message_id)).toEqual([{ reader: RUST }]);
  // The session ended: its hosted row is gone.
  expect(rows(`SELECT 1 FROM hosted_sessions WHERE source_session_id = ?`, SESSION)).toEqual([]);
  // The example minted one run token and revoked it at the end; the other credential's token is untouched.
  const tokens = (clientId: string) => rows<{ revoked: number }>(`SELECT t.revoked_at IS NOT NULL AS revoked FROM oauth_tokens t JOIN service_credentials c ON c.grant_id = t.grant_id WHERE c.client_id = ?`, clientId);
  expect(tokens(rust.client_id)).toEqual([{ revoked: 1 }]);
  expect(tokens(other.client_id)).toEqual([{ revoked: 0 }]);
}, 90_000);
