import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthGate, UNKNOWN_PEER_KEY } from "./auth_gate.ts";
import { openDatabase } from "./db.ts";

function gate(maxKeys?: number) {
  const { db, repo } = openDatabase(":memory:", { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  const clock = { t: 1_000_000 };
  const g = new AuthGate(repo, { limit: { burst: 1, perSec: 0.1 }, trustedProxies: [], now: () => clock.t, maxKeys });
  const audit = (action: string) => db.query(`SELECT target, detail FROM access_log WHERE action = ?`).all(action) as { target: string | null; detail: string }[];
  return { g, audit };
}

const req = (headers: Record<string, string> = {}) => new Request("http://x/api/whoami", { headers });

test("a request with no known peer is limited under the shared unknown bucket", () => {
  const { g } = gate();
  const c = g.caller(req(), null);
  expect(c).toEqual({ ip: null, key: UNKNOWN_PEER_KEY });
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
  } finally {
    err.mockRestore();
  }
});
