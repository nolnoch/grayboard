// Records the requests hosted-core's reference client (adapters/hosted-core/src/wire.ts)
// sends for each operation the Rust SDK implements, against a real server,
// into sdk/rust/schema/wire/requests.json. The Rust tests compare their own
// requests to it, and tests/integration/rust_fixtures.test.ts re-records and
// fails when the committed copy drifts: the envelope changed under the Rust
// SDK (#929; docs/sdk-rust.md §1, and docs/future/rust-sdk.md R1). Requests only: responses carry the server's version.
//
//   bun scripts/record_rust_fixtures.ts           rewrite the fixture
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeWire, Wire, type WireOptions } from "../adapters/hosted-core/src/wire.ts";
import { GRAYBOARD_SESSION_META } from "../src/shared/session_meta.ts";
import { issueOAuth } from "../tests/helpers/oauth.ts";
import { TestServer } from "../tests/support/server.ts";

export const FIXTURE_PATH = join(import.meta.dir, "../sdk/rust/schema/wire/requests.json");

// Every header is recorded but the HTTP stack's own (host, length, encoding, user agent, connection), so a header the
// reference client starts sending shows up as fixture drift. sdk/rust/grayboard/src/tests.rs drops the same set.
const TRANSPORT_HEADERS = new Set(["host", "content-length", "user-agent", "accept-encoding", "connection", "transfer-encoding"]);

export type RecordedRequest = { headers: Record<string, string>; body: unknown };
export type Fixture = { client: { name: string; version: string }; session: string; source: string; operations: Record<string, RecordedRequest[]> };

const CLIENT = { name: "fixture-client", version: "0.0.0" };
const SESSION = "fixture-session";
const SOURCE = "fixture-source";

// Ids, the bearer and the lease vary per run and per client; everything else is the envelope.
function normalize(headers: Headers, body: any): RecordedRequest {
  const kept: Record<string, string> = {};
  for (const [name, value] of [...headers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (TRANSPORT_HEADERS.has(name)) continue;
    kept[name] = name === "authorization" ? "Bearer <token>" : name === "x-grayboard-lease" ? "<lease>" : value;
  }
  if (body && "id" in body) body.id = "<id>";
  if (body?.params?.requestId !== undefined) body.params.requestId = "<id>";
  return { headers: kept, body };
}

export async function recordWire(): Promise<Fixture> {
  const server = new TestServer();
  const recorded: RecordedRequest[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === "POST") recorded.push(normalize(req.headers, JSON.parse(await req.clone().text())));
    return real(input, init);
  }) as typeof fetch;
  const operations: Record<string, RecordedRequest[]> = {};
  const op = async (name: string, run: () => Promise<unknown>) => {
    recorded.length = 0;
    await run();
    operations[name] = [...recorded];
  };
  const abort = new AbortController();
  try {
    const { token } = issueOAuth(server.app.repo, server.app.oauth.resource, "you@example.com", ["grayboard:tools", "grayboard:delivery"], Date.now(), "grayboard-pi");
    const options: WireOptions = { url: `${server.base}/mcp`, sessionKey: GRAYBOARD_SESSION_META, client: CLIENT, delivery: { mode: "push", source: SOURCE } as WireOptions["delivery"] };
    const auth = { token: async () => token };
    const native = new NativeWire(options, auth, abort.signal, SESSION);
    const subscriber = new Wire(options, auth, abort.signal, SESSION);
    await op("native_discover", () => native.connect());
    await op("native_call", () => native.client.callTool({ name: "bind", arguments: { name: "fixture-w1", create: true } }, native.options()));
    await op("native_list_tools", () => native.listTools());
    await op("subscriber_discover", () => subscriber.connect());
    let lease: { capability: string } | undefined;
    await op("subscriber_call", async () => { lease = await subscriber.call("delivery_open", {}) as { capability: string }; });
    await op("subscriber_list_tools", () => subscriber.takes("delivery_open", "fixture"));
    subscriber.capability = lease!.capability;
    await op("read_resource", () => subscriber.read("grayboard://inbox"));
    await op("listen_and_close", async () => { const sub = await subscriber.listen(); await sub.close(); });
    return { client: CLIENT, session: SESSION, source: SOURCE, operations };
  } finally {
    globalThis.fetch = real;
    abort.abort();
    await server.stop();
  }
}

export const serialize = (fixture: Fixture) => JSON.stringify(fixture, null, 2) + "\n";

if (import.meta.main) {
  writeFileSync(FIXTURE_PATH, serialize(await recordWire()));
  console.log(`wrote ${FIXTURE_PATH}`);
  process.exit(0);
}
