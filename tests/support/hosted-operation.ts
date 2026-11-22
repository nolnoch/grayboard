import { createApplication } from "../../src/server/application.ts";
import { createDelivery } from "../../src/server/delivery.ts";
import { openDatabase } from "../../src/server/db.ts";
import { sessionEndPort } from "../../src/server/session_end.ts";
import { createHostedSessions, sessionContext } from "../../src/server/hosted.ts";
import { OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import type { OAuthPrincipal } from "../../src/server/oauth.ts";

const [path, blobs, raw] = process.argv.slice(2);
const input = JSON.parse(raw!) as { principal: OAuthPrincipal; operation: "bind" | "register" | "end" | "revoke" | "sweep" | "receipt"; now: number; name?: string; rawSession?: string; child?: string; refreshHash?: string; sweepAt?: number };
const { db, repo } = openDatabase(path!, { blobDir: blobs!, sessionEnd: sessionEndPort("team") });
// A forced overlap parks one worker inside its transaction while the other waits on the lock. The server's 5 s busy
// timeout would decide that wait when a loaded machine is slow to commit after the release, failing the waiter with
// SQLITE_BUSY (#1134), so a worker outwaits any test's own timeout instead.
db.exec("PRAGMA busy_timeout = 60000");
const application = createApplication(repo);
let now = input.now;
const isAuthorized = (p: OAuthPrincipal, r = repo.read) => repo.oauth.isGrantActive(r, p.grantId, now);
const hosted = createHostedSessions(application, { now: () => now, isAuthorized }); await hosted.ready;
const context = sessionContext(input.principal, { [OPENCODE_SESSION_META]: input.rawSession ?? "root" });
const delivery = createDelivery(hosted, { isAuthorized });
const lease = input.operation === "receipt" ? await delivery.open(input.principal, context) : undefined;
const pending = lease ? await delivery.pending(input.principal, context, lease.capability) : [];
console.log("READY");
await Bun.stdin.text();
console.error("OPERATING");
try {
  let result: unknown;
  if (input.operation === "revoke") result = await repo.write(tx => repo.oauth.revokeToken(tx, input.refreshHash!, input.principal.clientId, now));
  else if (input.operation === "bind") result = await hosted.bind(input.principal, context, { name: input.name ?? "fe", create: true });
  else if (input.operation === "receipt") { await delivery.receipt(input.principal, context, lease!.capability, pending.map(item => item.id)); result = { cursor: await repo.cursors.directFor(repo.read, lease!.identity.identity_full) }; }
  else if (input.operation === "register") result = await hosted.register(input.principal, context, input.child!);
  else if (input.operation === "end") result = await hosted.end(input.principal, context);
  else { now = input.sweepAt!; await hosted.sweep(); result = { swept: true }; }
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  // The message too: a failure the test didn't expect (#1134) must say what it was.
  console.log(JSON.stringify({ ok: false, code: (error as { code?: string }).code, message: String((error as { message?: unknown }).message ?? error) }));
} finally {
  delivery.close(); await hosted.close(); application.stopExpiry(); db.close();
}
