import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "./config.ts";

const KEYS = [
  "GRAYBOARD_DEV_AUTH", "GRAYBOARD_DB_PATH", "GRAYBOARD_PUBLIC_URL", "GRAYBOARD_ORG_DOMAIN",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GRAYBOARD_ADMINS", "GRAYBOARD_ALLOWED_EMAILS",
  "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_TENANT_IDS",
];

const TENANT_A = "11111111-2222-3333-4444-555555555555";
const TENANT_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function setGoogle(): void {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "gid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "gsecret";
}

function setEntra(): void {
  process.env.ENTRA_CLIENT_ID = "eid";
  process.env.ENTRA_CLIENT_SECRET = "esecret";
  process.env.ENTRA_TENANT_IDS = TENANT_A;
}

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.GRAYBOARD_DB_PATH = ":memory:";
    process.env.GRAYBOARD_PUBLIC_URL = "https://grayboard.example.com";
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("dev auth refuses to start alongside a Google client secret", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_DEV_AUTH=1/);
  });

  test("dev auth refuses to start alongside an Entra client secret", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.ENTRA_CLIENT_SECRET = "secret";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_DEV_AUTH=1 must not be set alongside ENTRA_CLIENT_SECRET/);
  });

  test("outside dev auth, at least one provider is required", () => {
    expect(() => loadConfig()).toThrow(/no sign-in provider/);
  });

  test("Google with an org domain; no allowlist", () => {
    setGoogle();
    process.env.GRAYBOARD_ORG_DOMAIN = "Example.com";
    const c = loadConfig();
    expect(c.google).toEqual({ clientId: "gid", clientSecret: "gsecret", orgDomain: "example.com", allowedEmails: [] });
    expect(c.entra).toBeUndefined();
  });

  test("Google with only an allowlist", () => {
    setGoogle();
    process.env.GRAYBOARD_ALLOWED_EMAILS = "Pat@Gmail.com, sam@example.org";
    expect(loadConfig().google).toEqual({ clientId: "gid", clientSecret: "gsecret", allowedEmails: ["pat@gmail.com", "sam@example.org"] });
  });

  test("Google needs an org domain or an allowlist", () => {
    setGoogle();
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ORG_DOMAIN, GRAYBOARD_ALLOWED_EMAILS, or both/);
  });

  test("half a Google provider is an error", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "gid";
    process.env.GRAYBOARD_ORG_DOMAIN = "example.com";
    expect(() => loadConfig()).toThrow(/without GOOGLE_OAUTH_CLIENT_SECRET/);
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "gsecret";
    expect(() => loadConfig()).toThrow(/without GOOGLE_OAUTH_CLIENT_ID/);
  });

  test("Google's access settings without Google are an error", () => {
    setEntra();
    process.env.GRAYBOARD_ALLOWED_EMAILS = "pat@gmail.com";
    expect(() => loadConfig()).toThrow(/are for Google sign-in/);
    delete process.env.GRAYBOARD_ALLOWED_EMAILS;
    process.env.GRAYBOARD_ORG_DOMAIN = "example.com";
    expect(() => loadConfig()).toThrow(/are for Google sign-in/);
  });

  test("Entra alone", () => {
    setEntra();
    const c = loadConfig();
    expect(c.entra).toEqual({ clientId: "eid", clientSecret: "esecret", tenantIds: [TENANT_A] });
    expect(c.google).toBeUndefined();
  });

  test("Entra tenant IDs are lowercased GUIDs", () => {
    setEntra();
    process.env.ENTRA_TENANT_IDS = ` ${TENANT_A}, ${TENANT_B.toUpperCase()} `;
    expect(loadConfig().entra!.tenantIds).toEqual([TENANT_A, TENANT_B]);
    process.env.ENTRA_TENANT_IDS = "contoso.onmicrosoft.com";
    expect(() => loadConfig()).toThrow(/GUIDs, not "contoso.onmicrosoft.com"/);
  });

  test("half an Entra provider is an error", () => {
    setEntra();
    delete process.env.ENTRA_CLIENT_SECRET;
    expect(() => loadConfig()).toThrow(/without ENTRA_CLIENT_SECRET/);
    setEntra();
    delete process.env.ENTRA_TENANT_IDS;
    expect(() => loadConfig()).toThrow(/without ENTRA_TENANT_IDS/);
    setEntra();
    delete process.env.ENTRA_CLIENT_ID;
    expect(() => loadConfig()).toThrow(/without ENTRA_CLIENT_ID/);
  });

  test("both providers at once", () => {
    setGoogle();
    process.env.GRAYBOARD_ORG_DOMAIN = "example.com";
    setEntra();
    const c = loadConfig();
    expect(c.google?.clientId).toBe("gid");
    expect(c.entra?.clientId).toBe("eid");
  });

  test("dev auth starts without any provider", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().devAuth).toBe(true);
  });

  test("GRAYBOARD_ADMINS is a trimmed, lowercased email list; unset means none", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().admins).toEqual([]);
    process.env.GRAYBOARD_ADMINS = " Alice@Example.com, bob@example.com ,,";
    expect(loadConfig().admins).toEqual(["alice@example.com", "bob@example.com"]);
  });
});
