import { createApplication } from "../../src/server/application.ts";
import { createDelivery } from "../../src/server/delivery.ts";
import { openDatabase } from "../../src/server/db.ts";
import { createHostedSessions, sessionContext } from "../../src/server/hosted.ts";
import { OPENCODE_SESSION_META } from "../../src/server/oauth-config.ts";
import type { OAuthPrincipal } from "../../src/server/oauth.ts";

const [path, blobs, raw] = process.argv.slice(2);
const input = JSON.parse(raw!) as { principal: OAuthPrincipal; operation: "bind" | "register" | "end" | "revoke" | "sweep" | "receipt"; now: number; name?: string; rawSession?: string; child?: string; refreshHash?: string; sweepAt?: number };
const { db, repo } = openDatabase(path!, { blobDir: blobs! });
const application = createApplication(repo);
let now = input.now;
const hosted = createHostedSessions(application, { now: () => now, isAuthorized: (p, r = repo.read) => repo.oauth.isGrantActive(r, p.grantId, now) });
const context = sessionContext(input.principal, { [OPENCODE_SESSION_META]: input.rawSession ?? "root" });
const delivery = createDelivery(hosted, { isAuthorized: (p, r = repo.read) => repo.oauth.isGrantActive(r, p.grantId, now) });
const lease = input.operation === "receipt" ? await delivery.open(input.principal, context) : undefined;
const pending = lease ? await delivery.pending(input.principal, context, lease.capability) : [];
console.log("READY");
await Bun.stdin.text();
console.error("OPERATING");
try {
  let result: unknown;
  if (input.operation === "revoke") result = await repo.write(tx => repo.oauth.revokeToken(tx, input.refreshHash!, input.principal.clientId, now));
  else if (input.operation === "bind") result = await hosted.bind(input.principal, context, { name: input.name ?? "fe", create: true });
  else if (input.operation === "receipt") { await delivery.receipt(input.principal, context, lease!.capability, pending.map(item => item.id)); result = { cursor: repo.cursors.directFor(repo.read, lease!.identity.identity_full) }; }
  else if (input.operation === "register") result = await hosted.register(input.principal, context, input.child!);
  else if (input.operation === "end") result = await hosted.end(input.principal, context);
  else { now = input.sweepAt!; hosted.sweep(); result = { swept: true }; }
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: (error as { code?: string }).code }));
} finally {
  delivery.close(); hosted.close(); application.stopExpiry(); db.close();
}
