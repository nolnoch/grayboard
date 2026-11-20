// The Rust SDK's listen-cap fixture (sdk/rust/schema/wire/listen-capacity.json)
// is the response a real server sends a listen past the per-user listen cap:
// status, content type and body, byte for byte. The crate's transport test
// (`the_servers_listen_cap_refusal_is_capacity_with_its_body_unchanged`,
// scripts/e2e.sh rust-sdk) serves those bytes and asserts the Rust transport
// raises them as `Error::Capacity` with the body unchanged, equal to the
// constant its swap retry matches (`delivery.rs` `LISTEN_CAPACITY`). This root
// test, with no cargo, fails when the server's response drifts from the
// fixture; edit the fixture to the new response and run the crate's tests
// (#1398; #1394).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LISTEN_CAPACITY, Wire } from "../../adapters/hosted-core/src/wire.ts";
import { DEFAULT_MCP_LIMITS } from "../../src/server/config.ts";
import { GRAYBOARD_SESSION_META } from "../../src/shared/session_meta.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { TestServer } from "../support/server.ts";

const FIXTURE = join(import.meta.dir, "../../sdk/rust/schema/wire/listen-capacity.json");
const REQUESTS = join(import.meta.dir, "../../sdk/rust/schema/wire/requests.json");

let srv: TestServer | undefined;
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close().catch(() => {});
  await srv?.stop();
});

test("the Rust SDK's listen-cap fixture is the response a real server sends past the per-user listen cap", async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 }, mcpLimits: { ...DEFAULT_MCP_LIMITS, listen: { global: 128, perUser: 1 } } });
  const token = (await issueOAuth(srv.app.repo, srv.app.oauth.resource, "alice@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), "grayboard-pi")).token;
  // One listen holds the user's only slot.
  const wire = new Wire({ url: `${srv.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: { name: "grayboard-pi", version: "1.0.0" }, delivery: { mode: "push", source: "grayboard-pi" } }, { token: async () => token }, new AbortController().signal, "cap-holder");
  open.push(wire);
  await wire.connect();
  await wire.call("bind", { name: "be", create: true });
  wire.capability = (await wire.call("delivery_open") as { capability: string }).capability;
  open.push(await wire.listen());
  // A second listen, as the Rust SDK sends it (its recorded request), from the same user.
  const [listen] = JSON.parse(readFileSync(REQUESTS, "utf8")).operations.listen_and_close as { headers: Record<string, string>; body: Record<string, unknown> }[];
  const headers = { ...listen.headers, authorization: `Bearer ${token}`, "x-grayboard-lease": wire.capability! };
  const response = await fetch(`${srv.base}/mcp`, { method: "POST", headers, body: JSON.stringify({ ...listen.body, id: 1 }) });
  const real = { status: response.status, headers: { "content-type": response.headers.get("content-type") }, body: await response.text() };
  expect(real).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  // The body is the constant both clients' swap retries match (hosted-core here; Rust in the crate's test).
  expect(real.body).toBe(LISTEN_CAPACITY);
}, 30_000);
