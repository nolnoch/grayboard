import { describe, test, expect, beforeEach } from "bun:test";
import { checkEntraClaims, checkGoogleClaims, entraAuthority, entraIssuer, hashToken, LoginRefused, mintToken, verifySessionToken } from "./auth.ts";
import { openDatabase, type Repo } from "./db.ts";

describe("token helpers", () => {
  test("mintToken has gbrd_v1_ prefix", () => {
    expect(mintToken()).toMatch(/^gbrd_v1_/);
  });

  test("mintToken is unique", () => {
    expect(mintToken()).not.toBe(mintToken());
  });

  test("hashToken is deterministic", () => {
    const raw = "gbrd_v1_test";
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  test("hashToken different inputs produce different outputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("verifySessionToken", () => {
  let repo: Repo;

  beforeEach(() => {
    const { repo: r } = openDatabase(":memory:");
    repo = r;
  });

  test("valid token returns authed user", () => {
    const u   = repo.users.upsertByEmail("alice@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    const authed = verifySessionToken(raw, repo);
    expect(authed).not.toBeNull();
    expect(authed!.user_email).toBe("alice@example.com");
  });

  test("missing token returns null", () => {
    expect(verifySessionToken("gbrd_v1_nonexistent", repo)).toBeNull();
  });

  test("revoked token returns null", () => {
    const u   = repo.users.upsertByEmail("alice@example.com", null);
    const raw = mintToken();
    const s   = repo.sessions.create(u.id, hashToken(raw), null);
    repo.sessions.revoke(s.id);
    expect(verifySessionToken(raw, repo)).toBeNull();
  });

  test("disabled user returns null", () => {
    const u   = repo.users.upsertByEmail("alice@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    expect(verifySessionToken(raw, repo)).toBeNull();
  });

  test("re-enabled user returns authed user", () => {
    const u   = repo.users.upsertByEmail("alice@example.com", null);
    const raw = mintToken();
    repo.sessions.create(u.id, hashToken(raw), null);
    repo.users.setDisabled(u.id, true);
    repo.users.setDisabled(u.id, false);
    expect(verifySessionToken(raw, repo)).not.toBeNull();
  });
});

describe("checkGoogleClaims", () => {
  const cfg = { orgDomain: "example.com", allowedEmails: ["pat@gmail.com", "sam@example.org"] };
  const claims = (over: Record<string, unknown> = {}) => ({ sub: "g-1", email: "Alice@Example.com", email_verified: true, hd: "example.com", name: "Alice", ...over });

  test("an org-domain account passes, keyed by sub, authoritative", () => {
    expect(checkGoogleClaims(claims(), cfg)).toEqual({
      provider: "google", subject: "g-1", email: "alice@example.com", displayName: "Alice", authoritative: true,
    });
  });

  test("an allowlisted @gmail.com account passes and is authoritative", () => {
    const v = checkGoogleClaims(claims({ email: "pat@gmail.com", hd: undefined }), cfg);
    expect(v.authoritative).toBe(true);
  });

  test("an allowlisted address with no hd passes but isn't authoritative", () => {
    const v = checkGoogleClaims(claims({ email: "sam@example.org", hd: undefined }), cfg);
    expect(v.authoritative).toBe(false);
  });

  test("an allowlisted account in another Workspace domain is authoritative", () => {
    const v = checkGoogleClaims(claims({ email: "sam@example.org", hd: "example.org" }), cfg);
    expect(v.authoritative).toBe(true);
  });

  test("neither in the domain nor allowlisted is refused", () => {
    expect(() => checkGoogleClaims(claims({ email: "eve@gmail.com", hd: undefined }), cfg)).toThrow(/isn't in @example.com or on this server's allowlist/);
    expect(() => checkGoogleClaims(claims({ email: "eve@other.com", hd: "other.com" }), { allowedEmails: ["pat@gmail.com"] }))
      .toThrow(/isn't on this server's allowlist/);
  });

  test("an unverified email is refused, even allowlisted", () => {
    expect(() => checkGoogleClaims(claims({ email: "pat@gmail.com", hd: undefined, email_verified: false }), cfg)).toThrow(LoginRefused);
    expect(() => checkGoogleClaims(claims({ email_verified: "true" }), cfg)).toThrow(/hasn't verified/);
  });

  test("missing email or sub is refused", () => {
    expect(() => checkGoogleClaims(claims({ email: undefined }), cfg)).toThrow(/no email claim/);
    expect(() => checkGoogleClaims(claims({ sub: undefined }), cfg)).toThrow(/no sub claim/);
  });
});

describe("checkEntraClaims", () => {
  const TID = "11111111-2222-3333-4444-555555555555";
  const OID = "99999999-8888-7777-6666-555555555555";
  const cfg = { tenantIds: [TID] };
  const claims = (over: Record<string, unknown> = {}) => ({
    ver: "2.0", iss: entraIssuer(TID), tid: TID, oid: OID, acct: 0, email: "Alice@Example.com", xms_edov: true, name: "Alice", ...over,
  });

  test("a verified member passes, keyed by tid:oid", () => {
    expect(checkEntraClaims(claims(), cfg)).toEqual({
      provider: "entra", subject: `${TID}:${OID}`, email: "alice@example.com", displayName: "Alice", authoritative: true,
    });
  });

  test("the authority is the tenant for one, organizations for several", () => {
    expect(entraAuthority([TID])).toBe(TID);
    expect(entraAuthority([TID, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])).toBe("organizations");
  });

  test("a tenant not on the list is refused", () => {
    const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(() => checkEntraClaims(claims({ tid: other, iss: entraIssuer(other) }), cfg)).toThrow(/isn't allowed/);
  });

  test("an issuer for another tenant is refused", () => {
    expect(() => checkEntraClaims(claims({ iss: entraIssuer("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") }), cfg)).toThrow(/issuer doesn't match/);
  });

  test("a v1 token is refused", () => {
    expect(() => checkEntraClaims(claims({ ver: "1.0" }), cfg)).toThrow(/v2.0/);
  });

  test("a missing oid is refused", () => {
    expect(() => checkEntraClaims(claims({ oid: undefined }), cfg)).toThrow(/no oid/);
  });

  test("guests are refused; a missing acct names the optional claim", () => {
    expect(() => checkEntraClaims(claims({ acct: 1 }), cfg)).toThrow(/guest accounts/);
    expect(() => checkEntraClaims(claims({ acct: undefined }), cfg)).toThrow(/acct optional claim/);
  });

  test("email counts only with xms_edov true", () => {
    expect(() => checkEntraClaims(claims({ email: undefined }), cfg)).toThrow(/email optional claim/);
    expect(() => checkEntraClaims(claims({ xms_edov: undefined }), cfg)).toThrow(/xms_edov optional claim/);
    expect(() => checkEntraClaims(claims({ xms_edov: false }), cfg)).toThrow(/hasn't verified.*xms_edov is false/);
    expect(() => checkEntraClaims(claims({ xms_edov: "1" }), cfg)).toThrow(/xms_edov is "1"/);
  });

  test("a refusal carries the claimed email for the audit log", () => {
    try { checkEntraClaims(claims({ acct: 1 }), cfg); throw new Error("passed"); }
    catch (e) { expect((e as LoginRefused).claimedEmail).toBe("alice@example.com"); }
  });
});
