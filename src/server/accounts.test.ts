import { describe, test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { resolveLogin } from "./accounts.ts";
import { LoginRefused, type VerifiedLogin } from "./auth.ts";
import { openDatabase, type Repo } from "./db.ts";

let repo: Repo;
let db: Database;

beforeEach(() => {
  ({ repo, db } = openDatabase(":memory:"));
});

const google = (over: Partial<VerifiedLogin> = {}): VerifiedLogin =>
  ({ provider: "google", subject: "g-1", email: "alice@example.com", displayName: "Alice", authoritative: true, ...over });
const entra = (over: Partial<VerifiedLogin> = {}): VerifiedLogin =>
  ({ provider: "entra", subject: "tid:oid-1", email: "alice@example.com", displayName: "Alice", authoritative: true, ...over });

function audit(action: string): Record<string, unknown>[] {
  return db.query<{ detail: string }, [string]>("SELECT detail FROM access_log WHERE action = ? ORDER BY id").all(action)
    .map(r => JSON.parse(r.detail));
}

function refusal(v: VerifiedLogin): string {
  try { resolveLogin(repo, v); } catch (e) { if (e instanceof LoginRefused) return e.message; throw e; }
  throw new Error("login was not refused");
}

describe("resolveLogin", () => {
  test("a new address creates the user and links the account", () => {
    const { user, event } = resolveLogin(repo, google());
    expect(event).toBe("created");
    expect(user.email).toBe("alice@example.com");
    expect(repo.links.find("google", "g-1")?.user_id).toBe(user.id);
    expect(audit("auth.linked")).toEqual([{ provider: "google", subject: "g-1", trust: "new_user" }]);
  });

  test("a known link signs in as its user and updates last_login_at", () => {
    const first = resolveLogin(repo, google()).user;
    db.run("UPDATE auth_links SET last_login_at = 1");
    const { user, event } = resolveLogin(repo, google({ displayName: "Alice B" }));
    expect(event).toBe("login");
    expect(user.id).toBe(first.id);
    expect(user.display_name).toBe("Alice B");
    expect(repo.links.find("google", "g-1")!.last_login_at).toBeGreaterThan(1);
  });

  test("a known link whose email changed is refused", () => {
    resolveLogin(repo, entra());
    expect(refusal(entra({ email: "renamed@example.com" }))).toMatch(/signs in as alice@example.com but now reports renamed@example.com/);
    expect(repo.users.findByEmail("renamed@example.com")).toBeUndefined();
  });

  test("an existing user with no links binds on an authoritative login (the upgrade path)", () => {
    const u = repo.users.upsertByEmail("alice@example.com", null);
    const { user, event } = resolveLogin(repo, google());
    expect(event).toBe("linked");
    expect(user.id).toBe(u.id);
    expect(audit("auth.linked")).toEqual([{ provider: "google", subject: "g-1", trust: "provider" }]);
  });

  test("a non-authoritative address binds only on the user's first sign-in", () => {
    repo.users.upsertByEmail("sam@example.org", null);
    const { event } = resolveLogin(repo, google({ email: "sam@example.org", authoritative: false }));
    expect(event).toBe("linked");
    expect(audit("auth.linked")).toEqual([{ provider: "google", subject: "g-1", trust: "first_use" }]);
  });

  test("a non-authoritative address can't join a user who already signs in another way", () => {
    resolveLogin(repo, entra({ email: "sam@example.org" }));
    expect(refusal(google({ email: "sam@example.org", authoritative: false }))).toMatch(/doesn't own sam@example.org's domain.*already signs in with entra/);
    expect(repo.links.find("google", "g-1")).toBeUndefined();
  });

  test("an authoritative second provider links to the same user", () => {
    const a = resolveLogin(repo, google()).user;
    const { user, event } = resolveLogin(repo, entra());
    expect(event).toBe("linked");
    expect(user.id).toBe(a.id);
    expect(repo.links.forUser(a.id).map(l => l.provider)).toEqual(["entra", "google"]);
  });

  test("a recreated account at an authoritative provider re-links", () => {
    const a = resolveLogin(repo, google()).user;
    const { user, event } = resolveLogin(repo, google({ subject: "g-2" }));
    expect(event).toBe("relinked");
    expect(user.id).toBe(a.id);
    expect(repo.links.find("google", "g-1")).toBeUndefined();
    expect(repo.links.find("google", "g-2")?.user_id).toBe(a.id);
    expect(audit("auth.relinked")).toEqual([{ provider: "google", subject: "g-2", previous: "g-1" }]);
  });

  test("a different non-authoritative account for the same provider is refused", () => {
    resolveLogin(repo, google({ email: "sam@example.org", authoritative: false }));
    expect(refusal(google({ subject: "g-2", email: "sam@example.org", authoritative: false })))
      .toMatch(/already signs in with a different Google account/);
  });

  test("unlinking lets a non-authoritative account bind again", () => {
    const u = resolveLogin(repo, google({ email: "sam@example.org", authoritative: false })).user;
    expect(repo.links.unlink(u.id, "google")).toBe(1);
    expect(resolveLogin(repo, google({ subject: "g-2", email: "sam@example.org", authoritative: false })).event).toBe("linked");
  });

  test("unlink without a provider clears every link", () => {
    const u = resolveLogin(repo, google()).user;
    resolveLogin(repo, entra());
    expect(repo.links.unlink(u.id)).toBe(2);
    expect(repo.links.forUser(u.id)).toEqual([]);
  });

  test("a disabled user is refused, linked or not", () => {
    const u = resolveLogin(repo, google()).user;
    repo.users.setDisabled(u.id, true);
    expect(refusal(google())).toMatch(/is disabled/);
    expect(refusal(entra())).toMatch(/is disabled/);
    expect(repo.links.find("entra", "tid:oid-1")).toBeUndefined();
  });
});
