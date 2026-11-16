// The Rust SDK's example (sdk/rust/grayboard/examples/roundtrip.rs) against a
// real server over HTTP, as a queue worker (#929 stage 3; docs/sdk-rust.md §2): it binds, subscribes
// to a queue board in push mode and opens its delivery stream; a TS hosted
// session posts a work item and sends it a DM; the example takes both from the
// stream, receipts them, replies in the item's thread and dm_acks the DM, then
// ends. Asserted on server state, not the example's output. Cargo isn't on dev
// boxes or in the pre-push hook, so this runs only when GRAYBOARD_RUST_EXAMPLE
// names the built example; `scripts/e2e.sh rust-sdk` builds it and sets it.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { issueOAuth } from "../helpers/oauth.ts";
import { hostedServer, type HostedServer } from "../support/hosted_oauth.ts";
import { until } from "../support/until.ts";

const example = process.env.GRAYBOARD_RUST_EXAMPLE;
const CLIENT = "rust-sdk-test";
const EMAIL = "alice@example.com";
const SESSION = "rust-roundtrip-1";
const RUST = `${EMAIL}/rust-w1`;

if (!example) console.log("rust_sdk: skipped (set GRAYBOARD_RUST_EXAMPLE to the built roundtrip example, or run scripts/e2e.sh rust-sdk)");

let srv: HostedServer | undefined;
afterEach(() => srv?.stop());

test.skipIf(!example)("the Rust roundtrip example works a queue item and a DM from its delivery stream", async () => {
  expect(existsSync(example!)).toBe(true);
  srv = hostedServer({ oauthClients: [{ clientId: CLIENT, name: "Rust SDK test", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none", sessionSource: true }] }, EMAIL);
  const db = srv.app.db;
  const rows = <T>(sql: string, ...args: (string | number)[]) => db.query(sql).all(...args) as T[];
  const peer = await srv.hosted(EMAIL, "ts-peer");
  await peer.call("board_create", { name: "work", purpose: "rust sdk queue", kind: "queue" });
  const { token } = issueOAuth(srv.app.repo, srv.resource, EMAIL, ["grayboard:tools", "grayboard:delivery"], Date.now(), CLIENT);

  const run = Bun.spawn([example!, "rust-w1", "work"], {
    env: { ...process.env, GRAYBOARD_URL: `${srv.issuer}/mcp`, GRAYBOARD_TOKEN: token, GRAYBOARD_SESSION: SESSION },
    stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => run.kill(), 60_000);
  const output = Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);

  // Post only once the Rust session is subscribed and holds an open lease, so the item reaches it through its stream.
  await until(() => rows(`SELECT 1 FROM subscriptions WHERE board = 'work' AND handle = ? AND mode = 'push'`, RUST).length === 1
    && rows(`SELECT 1 FROM hosted_sessions WHERE source_session_id = ? AND lease_deadline IS NOT NULL`, SESSION).length === 1, 30_000, "the Rust session subscribed with an open lease");
  const posted = await peer.call<{ post_id: number }>("board_post", { board: "work", body: "work item" });
  const key = `queue:work:${posted.post_id}`;
  expect(rows(`SELECT holder FROM claims WHERE key = ?`, key)).toEqual([{ holder: RUST }]);
  const sent = await peer.call<{ message_id: number }>("dm_send", { to: RUST, body: "a direct message" });

  const [code, out, err] = await output;
  clearTimeout(killer);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain(`acked ${sent.message_id}`);

  // The reply is in the item's thread, written as the Rust name, and released the queue claim.
  expect(rows(`SELECT author, body FROM posts WHERE parent_id = ?`, posted.post_id)).toEqual([{ author: RUST, body: "done" }]);
  expect(rows(`SELECT holder FROM claims WHERE key = ?`, key)).toEqual([]);
  // The DM was acked by its reader.
  expect(rows(`SELECT reader FROM dm_acks WHERE message_id = ?`, sent.message_id)).toEqual([{ reader: RUST }]);
  // The session ended: its hosted row is gone.
  expect(rows(`SELECT 1 FROM hosted_sessions WHERE source_session_id = ?`, SESSION)).toEqual([]);
}, 90_000);
