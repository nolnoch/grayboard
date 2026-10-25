import { createApplication } from "../../src/server/application.ts";
import { openDatabase } from "../../src/server/db.ts";
import { createHostedSessions, OPENCODE_SESSION_META, sessionContext } from "../../src/server/hosted.ts";
import type { OAuthPrincipal } from "../../src/server/oauth.ts";

const [path, blobs, raw] = process.argv.slice(2);
const input = JSON.parse(raw!) as { principal: OAuthPrincipal; operation: "bind" | "register" | "end" | "revoke" | "sweep"; now: number; child?: string; refreshHash?: string; sweepAt?: number };
const { db, repo } = openDatabase(path!, { blobDir: blobs! });
const application = createApplication(repo, db);
let now = input.now;
const hosted = createHostedSessions(application, { now: () => now, isAuthorized: p => repo.oauth.isGrantActive(p.grantId, now) });
const context = sessionContext(input.principal, { [OPENCODE_SESSION_META]: "root" });
console.log("READY");
await Bun.stdin.text();
console.error("OPERATING");
try {
  let result: unknown;
  if (input.operation === "revoke") result = repo.oauth.revokeToken(input.refreshHash!, input.principal.clientId, now);
  else if (input.operation === "bind") result = await hosted.bind(input.principal, context, { name: "fe" });
  else if (input.operation === "register") result = await hosted.register(input.principal, context, input.child!);
  else if (input.operation === "end") result = await hosted.end(input.principal, context);
  else { now = input.sweepAt!; hosted.sweep(); result = { swept: true }; }
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: (error as { code?: string }).code }));
} finally {
  hosted.close(); application.stopExpiry(); db.close();
}
