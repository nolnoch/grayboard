// The per-address limit on authentication failures (#240), and the plugin
// client's side of it: it stops retrying a refused token, and waits out a
// limited address instead of hammering it.
import { afterEach, expect, test } from "bun:test";

import { mintSessionKey } from "../../src/core/bindings.ts";
import { GrayboardClient } from "../../src/plugin/client.ts";
import { until } from "../support/until.ts";

const A = "alice@example.com";
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

const HELLO_OK = { type: "hello_ok", identity_full: `${A}/fe`, user_email: A, teams: [] };

// A stand-in server that accepts only the token `good()` names: anything
// else gets `refuse()` on the upgrade and on /api/whoami. Records when each
// upgrade attempt and probe came.
function stub(good: () => string, refuse: () => Response) {
  const upgrades: number[] = [];
  const whoami: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      const ok = req.headers.get("authorization") === `Bearer ${good()}`;
      if (new URL(req.url).pathname === "/api/whoami") {
        whoami.push(Date.now());
        return ok ? Response.json({}) : refuse();
      }
      upgrades.push(Date.now());
      if (ok && server.upgrade(req)) return;
      return refuse();
    },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") ws.send(JSON.stringify({ req_id: m.req_id, ...HELLO_OK }));
      },
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://localhost:${server.port}`, upgrades, whoami, server };
}

const unauthenticated = () => Response.json({ code: "unauthenticated", message: "invalid token" }, { status: 401 });

test("after a confirmed 401 a running client stops retrying, and reconnects at once on a new token or after the slow retry", async () => {
  let valid = "t1";
  let token = "t1";
  const s = stub(() => valid, unauthenticated);
  const c = new GrayboardClient(s.url, () => token, "fe", mintSessionKey(), async () => {}, async () => {}, true, undefined, { tokenPollMs: 50, signedOutRetryMs: 3000 });
  cleanup.push(() => c.close());
  c.connect();
  await c.ready();

  // The token is revoked and the connection drops: one reconnect (after the
  // 1s backoff) is refused, and the probe confirms it.
  valid = "t2";
  (c as any).ws.close();
  await until(() => s.whoami.length === 1, 3000);
  const refusedAt = s.upgrades.length;
  // The slow retry tries the old token once more, and is refused again; the
  // backoff alone would have tried after 2s.
  await until(() => s.whoami.length === 2, 4000);
  expect(s.upgrades.length).toBe(refusedAt + 1);
  expect(s.whoami[1]! - s.whoami[0]!).toBeGreaterThanOrEqual(2900);

  // A new sign-in is seen at the next look (50ms), not at the slow retry.
  const t = Date.now();
  token = "t2";
  await c.ready();
  expect(Date.now() - t).toBeLessThan(1000);
}, 10_000);
