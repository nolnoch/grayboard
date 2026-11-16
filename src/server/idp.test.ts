import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessAudits } from "../../tests/support/audit.ts";
import { scratchDbPath } from "../../tests/support/scratch_db.ts";
import { seed } from "../../tests/support/seed.ts";
import { openDatabase, type Repo } from "./db.ts";
import { idpSignIn, type SignInProvider } from "./idp.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";

const google: SignInProvider = { id: "google", label: "Google", issuer: GOOGLE_ISSUER };
const okta: SignInProvider = { id: "okta", label: "Okta", issuer: "https://example.okta.com" };
const fresh = () => openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
const id = (email: string, subject: string) => ({ email, subject, displayName: null });
// In a queued body, as the OAuth callback runs it (#807 P1b-4f).
const signIn = (repo: Repo, ...a: Parameters<typeof idpSignIn> extends [Repo, ...infer R] ? R : never) => seed(repo, () => idpSignIn(repo, ...a));

// Security audit F-13, #928 D4/D9: each refusal says what the admin runs, and audits why, with the provider and issuer.
test("idpSignIn refuses a reassigned or changed email with the admin's fix, and audits each outcome", async () => {
  const { db, repo } = fresh();
  await seed(repo, () => repo.users.upsertByEmail("old@example.com", null));
  expect(await signIn(repo, google, id("old@example.com", "s-old"), { ip: "1.2.3.4" })).toMatchObject({ user: { email: "old@example.com" } });
  expect(accessAudits(db, "auth.subject_linked").map(r => [r.actor, r.detail])).toEqual([["old@example.com", { provider: "google", issuer: GOOGLE_ISSUER, ip: "1.2.3.4" }]]);

  const mismatch = await signIn(repo, google, id("old@example.com", "s-hire"), { ip: "1.2.3.4" });
  expect(mismatch).toEqual({ refused: "old@example.com is linked to a different Google account. If this account should have it, an admin runs grayboard admin unlink-idp --email old@example.com" });
  const changed = await signIn(repo, google, id("new@example.com", "s-old"), { ip: "1.2.3.4" });
  expect(changed).toEqual({ refused: expect.stringContaining("belongs to grayboard user old@example.com but now reports new@example.com") });
  expect(accessAudits(db, "auth.subject_refused").map(r => [r.actor, r.detail])).toEqual([
    ["old@example.com", { reason: "subject_mismatch", provider: "google", issuer: GOOGLE_ISSUER, ip: "1.2.3.4" }],
    ["old@example.com", { reason: "email_changed", email: "new@example.com", provider: "google", issuer: GOOGLE_ISSUER, ip: "1.2.3.4" }],
  ]);
});

test("idpSignIn refuses an email another provider holds, naming that provider and the unlink, and audits the holding issuer", async () => {
  const { db, repo } = fresh();
  expect(await signIn(repo, google, id("a@example.com", "s-1"))).toMatchObject({ user: { idp_issuer: GOOGLE_ISSUER } });
  expect(await signIn(repo, okta, id("a@example.com", "o-1"), { client_id: "native" }, [google, okta])).toEqual({
    refused: "a@example.com is linked to a Google account, not Okta. If this Okta account should have it, an admin runs grayboard admin unlink-idp --email a@example.com",
  });
  // A holder the server doesn't list is named by its issuer.
  expect(await signIn(repo, okta, id("a@example.com", "o-1"))).toEqual({ refused: expect.stringContaining(`linked to a ${GOOGLE_ISSUER} account, not Okta`) });
  expect(accessAudits(db, "auth.subject_refused").map(r => [r.actor, r.detail])[0]).toEqual(
    ["a@example.com", { reason: "issuer_mismatch", holding_issuer: GOOGLE_ISSUER, provider: "okta", issuer: okta.issuer, client_id: "native" }]);
  expect(repo.users.findByEmail("a@example.com")).toMatchObject({ idp_issuer: GOOGLE_ISSUER, idp_subject: "s-1" });
});
