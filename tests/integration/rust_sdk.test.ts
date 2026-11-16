// The Rust SDK's example (sdk/rust/grayboard/examples/roundtrip.rs) against a
// real server over HTTP: it binds a name and posts with an operator client's
// token, and a TS hosted session sees the post. Cargo isn't on dev boxes or in
// the pre-push hook, so this runs only when GRAYBOARD_RUST_EXAMPLE names the
// built example; `scripts/e2e.sh rust-sdk` builds it and sets it (#929).
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { issueOAuth } from "../helpers/oauth.ts";
import { hostedServer, type HostedServer } from "../support/hosted_oauth.ts";

const example = process.env.GRAYBOARD_RUST_EXAMPLE;
const CLIENT = "rust-sdk-test";
const EMAIL = "alice@example.com";

if (!example) console.log("rust_sdk: skipped (set GRAYBOARD_RUST_EXAMPLE to the built roundtrip example, or run scripts/e2e.sh rust-sdk)");

let srv: HostedServer | undefined;
afterEach(() => srv?.stop());

test.skipIf(!example)("the Rust roundtrip example binds and posts through hosted MCP", async () => {
  expect(existsSync(example!)).toBe(true);
  srv = hostedServer({ oauthClients: [{ clientId: CLIENT, name: "Rust SDK test", redirectUris: ["http://127.0.0.1/callback"], scopes: ["grayboard:tools", "grayboard:delivery"], tokenEndpointAuthMethod: "none", sessionSource: true }] }, EMAIL);
  const peer = await srv.hosted(EMAIL, "ts-peer");
  await peer.call("board_create", { name: "e2e", purpose: "rust sdk" });
  const { token } = issueOAuth(srv.app.repo, srv.resource, EMAIL, ["grayboard:tools", "grayboard:delivery"], Date.now(), CLIENT);

  const run = Bun.spawn([example!, "rust-w1", "e2e", "hello from rust"], {
    env: { ...process.env, GRAYBOARD_URL: `${srv.issuer}/mcp`, GRAYBOARD_TOKEN: token, GRAYBOARD_SESSION: "rust-roundtrip-1" },
    stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => run.kill(), 60_000);
  const [code, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  clearTimeout(killer);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.length).toBeGreaterThan(0);

  const read = await peer.call<{ posts: { body: string; author: string }[] }>("board_read", { board: "e2e" });
  expect(read.posts.map((p) => [p.author, p.body])).toEqual([[`${EMAIL}/rust-w1`, "hello from rust"]]);
}, 90_000);
