import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthGate, REFUSED_TOKEN_TTL_MS, SITE_LIMIT_FACTOR, UNKNOWN_PEER_KEY } from "./auth_gate.ts";
import { openDatabase } from "./db.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

function gate(maxKeys?: number, refusedMax?: number, burst = 1) {
  const { db, repo } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const clock = { t: 1_000_000 };
  const g = new AuthGate(repo, { limit: { burst, perSec: 0.1 }, trustedProxies: [], now: () => clock.t, maxKeys, refusedMax });
  const audit = (action: string) => db.query(`SELECT target, detail FROM access_log WHERE action = ?`).all(action) as { target: string | null; detail: string }[];
  return { g, audit, clock };
}

const req = (headers: Record<string, string> = {}) => new Request("http://x/api/whoami", { headers });

test("a request with no known peer is limited under the shared unknown bucket", () => {
  const { g } = gate();
  const c = g.caller(req(), null);
  expect(c).toEqual({ ip: null, key: UNKNOWN_PEER_KEY, site: null });
  expect(g.caller(req(), undefined)).toEqual(c);
  g.charge(c, req(), "/api/whoami", "refused token");
  expect(g.refuse(c, "/api/whoami")?.status).toBe(429);
  // Known peers keep their own buckets.
  expect(g.refuse(g.caller(req(), "198.51.100.1"), "/api/whoami")).toBeNull();
});

test("at the key cap a new address goes uncharged, with an audit row counting them", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { g, audit } = gate(1);
    const a = g.caller(req(), "198.51.100.1");
    const b = g.caller(req(), "198.51.100.2");
    g.charge(a, req(), "/api/whoami", "refused token");
    g.charge(b, req(), "/api/whoami", "refused token");
    expect(g.size).toBe(1);
    expect(g.refuse(b, "/api/whoami")).toBeNull();
    const rows = audit("auth.rate_limit_full");
    expect(rows.length).toBe(1);
    expect(rows[0]!.target).toBeNull();
    expect(JSON.parse(rows[0]!.detail)).toEqual({ tracked: 1, uncharged: 1 });
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      "[grayboard] auth-failure limiter is tracking 1 addresses, its cap; 1 failures from new addresses went uncharged",
    ]);
  } finally {
    err.mockRestore();
  }
});

// A refused request with `token`, and the 401 it got.
const bad = (token: string) => req({ Authorization: `Bearer ${token}` });
const refusal = () => Response.json({ code: "unauthenticated" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

test("refusals of one token in flight together are charged once, and replayed with their headers and body (#923)", async () => {
  const { g } = gate(undefined, undefined, 2);
  const c = g.caller(req(), "198.51.100.1");
  // Both completed before either's body was read: the second sees the first's entry.
  const [one, two] = [g.chargeRefusedToken(c, bad("stale"), "/api/whoami", refusal()), g.chargeRefusedToken(c, bad("stale"), "/api/whoami", refusal())];
  expect((await one).status).toBe(401);
  expect((await two).status).toBe(401);
  // Burst 2, charged once: not limited yet.
  expect(g.refuse(c, "/api/whoami")).toBeNull();
  const replayed = await g.replayRefused(bad("stale"), new URL("http://x/api/whoami"))!;
  expect(replayed.status).toBe(401);
  expect(replayed.headers.get("www-authenticate")).toBe("Bearer");
  expect(await replayed.json()).toEqual({ code: "unauthenticated" });
  expect(g.replayRefused(bad("other"), new URL("http://x/api/whoami"))).toBeNull();
  expect(g.replayRefused(bad("stale"), new URL("http://x/api/claims"))).toBeNull();
});

test("past the cap the oldest refusal is forgotten; the sweep drops expired ones; a valid response is never remembered", async () => {
  const { g, clock } = gate(undefined, 2);
  const c = g.caller(req(), "198.51.100.1");
  const at = new URL("http://x/api/whoami");
  for (const t of ["a", "b", "c"]) await g.chargeRefusedToken(c, bad(t), "/api/whoami", refusal());
  expect(g.refusedSize).toBe(2);
  expect(g.replayRefused(bad("a"), at)).toBeNull();
  expect(g.replayRefused(bad("c"), at)).not.toBeNull();
  await g.chargeRefusedToken(c, bad("ok"), "/api/whoami", Response.json({}, { status: 200 }));
  await g.chargeRefusedToken(c, req(), "/api/whoami", refusal());
  expect(g.refusedSize).toBe(2);
  clock.t += REFUSED_TOKEN_TTL_MS;
  expect(g.replayRefused(bad("c"), at)).toBeNull();
  g.sweep();
  expect(g.refusedSize).toBe(0);
});

// #274: one IPv6 /48 rotating through its /64s spends one shared /48 bucket.
const v6 = (site: number, net: number) => `2001:db8:${site.toString(16)}:${net.toString(16)}::1`;

test("a /48 rotating /64s can't grow the limiter past the /48's burst, and a fresh /64 under a drained /48 is refused", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { g, audit } = gate(undefined, undefined, 2);
    const burst48 = 2 * SITE_LIMIT_FACTOR;
    let net = 0;
    for (; net < 1000; net++) {
      const c = g.caller(req(), v6(1, net));
      if (g.refuse(c, "/api/whoami")) break;
      g.charge(c, req(), "/api/whoami", "refused token");
    }
    expect(net).toBe(burst48);
    expect(g.size).toBe(burst48);
    expect(g.siteSize).toBe(1);
    // A /64 never seen before, under the drained /48: 429, not an uncharged pass.
    expect(g.refuse(g.caller(req(), v6(1, 0xffff)), "/api/whoami")?.status).toBe(429);
    expect(g.size).toBe(burst48);
    // Another /48, and IPv4, are unaffected.
    expect(g.refuse(g.caller(req(), v6(2, 0)), "/api/whoami")).toBeNull();
    expect(g.refuse(g.caller(req(), "198.51.100.1"), "/api/whoami")).toBeNull();
    expect(audit("auth.rate_limited").map((r) => r.target)).toEqual(["2001:db8:1::/48"]);
  } finally {
    err.mockRestore();
  }
});

test("a /64 its own bucket refuses doesn't count against its /48, and IPv4 has no /48 tier", () => {
  const { g } = gate(undefined, undefined, 1);
  const c = g.caller(req(), v6(1, 0));
  expect(c.site).toBe("2001:db8:1::/48");
  expect(g.caller(req(), "198.51.100.1").site).toBeNull();
  g.charge(c, req(), "/api/whoami", "refused token");
  for (let i = 0; i < 50; i++) expect(g.refuse(c, "/api/whoami")?.status).toBe(429);
  // The /48 spent one token on the charge, none on the refusals.
  for (let net = 1; net < SITE_LIMIT_FACTOR; net++) {
    const n = g.caller(req(), v6(1, net));
    expect(g.refuse(n, "/api/whoami")).toBeNull();
    g.charge(n, req(), "/api/whoami", "refused token");
  }
  expect(g.refuse(g.caller(req(), v6(1, 0xff)), "/api/whoami")?.status).toBe(429);
});

test("a client looping on one refused token costs its /48 one charge, as it does its /64 (#923)", async () => {
  const { g } = gate(undefined, undefined, 1);
  const c = g.caller(req(), v6(1, 0));
  const at = new URL("http://x/api/whoami");
  await g.chargeRefusedToken(c, bad("stale"), "/api/whoami", refusal());
  for (let i = 0; i < 50; i++) expect(g.replayRefused(bad("stale"), at)).not.toBeNull();
  // The /48 (burst 4) has spent one: three more /64s still pass.
  for (let net = 1; net < SITE_LIMIT_FACTOR; net++) expect(g.refuse(g.caller(req(), v6(1, net)), "/api/whoami")).toBeNull();
});
