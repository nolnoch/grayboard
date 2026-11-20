// #807 P3 A7d2b: the hosted gate's token check awaits, so a disable or revoke can commit between the check and the
// gate's body even with the write queue idle. The generation the check read under says so, and the body checks again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./client_addr.ts";
import { openDatabase } from "./db.ts";
import { createOAuthServer, type OAuthPrincipal } from "./oauth.ts";
import { createApplication } from "./application.ts";
import { createHostedSessions, sessionContext } from "./hosted.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "./oauth-config.ts";
import { hashToken } from "./auth.ts";
import { issueOAuth, type IssuedOAuth } from "../../tests/helpers/oauth.ts";
import { hostedPause } from "../../tests/support/hosted-pause.ts";
import { hostedRowCount } from "../../tests/support/hosted_rows.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";

let store: ReturnType<typeof openDatabase>;
let oauth: ReturnType<typeof createOAuthServer>;
let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
let issued: IssuedOAuth;
let principal: OAuthPrincipal;
let dir: string;
let now: number;
const origin = "https://grayboard.example.com";
const resource = `${origin}/hosted/mcp`;
beforeEach(async () => {
  now = Date.now();
  dir = mkdtempSync(join(tmpdir(), "gb-hosted-auth-"));
  store = openDatabase(join(dir, "bus.db"), { blobDir: dir });
  oauth = createOAuthServer(store.repo, { store: { kind: "sqlite" as const, path: scratchDbPath() }, blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: `${origin}:443/hosted`, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [], helloLimit: DEFAULT_HELLO_LIMIT, authFailLimit: DEFAULT_AUTH_FAIL_LIMIT, trustedProxies: DEFAULT_TRUSTED_PROXIES }, { now: () => now });
  issued = await issueOAuth(store.repo, resource, "alice@example.com", ["grayboard:tools"], now, OPENCODE_CLIENT);
  application = createApplication(store.repo);
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: (p, r) => oauth.isAuthorized(p, r) }); await hosted.ready;
  const authed = await oauth.authenticate(new Request(resource, { headers: { Authorization: `Bearer ${issued.token}` } }), ["grayboard:tools"]);
  if (authed instanceof Response) throw new Error("fixture auth failed");
  principal = authed;
});
afterEach(async () => {
  await hosted.close(); application.stopExpiry(); oauth.close();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
const admits = () => (store.db.query("SELECT count(*) AS n FROM access_log WHERE action LIKE 'hosted.%' AND actor = ?").get(issued.authed.user_email) as { n: number }).n;

for (const end of ["disable", "revoke"] as const) test(`a ${end} committed between the gate's check and its body refuses, with the queue idle, and admits no row`, async () => {
  const context = sessionContext(principal, { [OPENCODE_SESSION_META]: "gate-root" });
  const before = admits();
  const call = hostedPause("hosted:gate:checked", () => hosted.whoami(principal, context), async () => {
    await store.repo.write(tx => end === "disable" ? store.repo.users.setDisabled(tx, issued.authed.user_id, true) : store.repo.oauth.revokeToken(tx, hashToken(issued.token), OPENCODE_CLIENT, now));
  });
  await expect(call).rejects.toThrow("unauthenticated");
  expect(hostedRowCount(store.db)).toBe(0);
  expect(admits()).toBe(before);
});

// The gate reads its generation before the check, not after it: a disable that commits while the check awaits
// (after the check's reads) moves the generation past `g`, so the body checks again and refuses (#1150 audit F1).
test("a disable committed during the gate's check refuses, and admits no row", async () => {
  let calls = 0;
  const raced = createHostedSessions(application, { now: () => now, isAuthorized: async (p, r) => {
    const valid = await oauth.isAuthorized(p, r);
    // Call 1 is the entry check, call 2 the gate's check outside the transaction.
    if (++calls === 2) await store.repo.write(tx => store.repo.users.setDisabled(tx, issued.authed.user_id, true));
    return valid;
  } });
  await raced.ready;
  try {
    const before = admits();
    await expect(raced.whoami(principal, sessionContext(principal, { [OPENCODE_SESSION_META]: "gate-during" }))).rejects.toThrow("unauthenticated");
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(hostedRowCount(store.db)).toBe(0);
    expect(admits()).toBe(before);
  } finally { await raced.close(); }
});
