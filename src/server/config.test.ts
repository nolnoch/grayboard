import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { checkIdpConfig, describeBlobs, describeReauth, describeStore, FILE_SECRETS, loadConfig } from "./config.ts";

const KEYS = [
  "GRAYBOARD_DEV_AUTH", "GRAYBOARD_DB_PATH", "GRAYBOARD_DATABASE_URL", "GRAYBOARD_PUBLIC_URL", "GRAYBOARD_ORG_DOMAIN",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GRAYBOARD_ADMINS", "GRAYBOARD_TEAM_CREATE",
  "GRAYBOARD_MCP_GOOGLE_CLIENT_ID", "GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET",
  "GRAYBOARD_IDPS", "GRAYBOARD_OKTA_ISSUER", "GRAYBOARD_OKTA_CLIENT_ID", "GRAYBOARD_OKTA_CLIENT_SECRET", "GRAYBOARD_OKTA_ALLOWED_DOMAINS",
  "GRAYBOARD_OIDC_ISSUER", "GRAYBOARD_OIDC_CLIENT_ID", "GRAYBOARD_OIDC_CLIENT_SECRET", "GRAYBOARD_OIDC_ALLOWED_DOMAINS", "GRAYBOARD_OIDC_LABEL",
  "GRAYBOARD_ATTACHMENT_MAX_BYTES", "GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES", "GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES", "GRAYBOARD_BLOB_DIR",
  "GRAYBOARD_MESSAGE_RETENTION_DAYS", "GRAYBOARD_AUDIT_RETENTION_DAYS", "GRAYBOARD_HTTP_PORT",
  "GRAYBOARD_HELLO_BURST", "GRAYBOARD_HELLO_PER_SEC",
  "GRAYBOARD_HOSTED_REQUEST_BURST", "GRAYBOARD_HOSTED_REQUEST_PER_SEC", "GRAYBOARD_HOSTED_SUBSCRIBER_BURST", "GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC",
  "GRAYBOARD_OAUTH_BURST", "GRAYBOARD_OAUTH_PER_SEC", "GRAYBOARD_OAUTH_GLOBAL_BURST", "GRAYBOARD_OAUTH_GLOBAL_PER_SEC",
  "GRAYBOARD_AUTH_FAIL_BURST", "GRAYBOARD_AUTH_FAIL_PER_SEC", "GRAYBOARD_TRUSTED_PROXIES", "GRAYBOARD_HOSTED_IDLE_SECONDS", "GRAYBOARD_CLI_TOKEN_IDLE_DAYS", "GRAYBOARD_IDP_REAUTH_DAYS", "GRAYBOARD_IDP_RECHECK_HOURS", "GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS", "GRAYBOARD_IDP_DISABLE_LIMIT", "GRAYBOARD_GOOGLE_DIRECTORY_KEY", "GRAYBOARD_GOOGLE_DIRECTORY_ADMIN",
  "GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID", "GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET", "GRAYBOARD_KEYCLOAK_DIRECTORY_URL",
  "GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT", "GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID", "GRAYBOARD_OKTA_DIRECTORY_KEY", "GRAYBOARD_OKTA_DIRECTORY_KEY_ID", "GRAYBOARD_OKTA_DIRECTORY_URL",
  "GRAYBOARD_DELEGATE_BURST", "GRAYBOARD_DELEGATE_PER_SEC", "GRAYBOARD_DELEGATE_OPEN_CAP", "GRAYBOARD_ALIAS_SCOPE_CAP",
  ...["LISTEN", "LEGACY", "POST"].flatMap(kind => [`GRAYBOARD_MCP_${kind}_GLOBAL`, `GRAYBOARD_MCP_${kind}_PER_USER`]),
  "GRAYBOARD_HOSTED_SESSIONS_GLOBAL", "GRAYBOARD_HOSTED_SESSIONS_PER_USER", "GRAYBOARD_DELIVERY_LEASES_GLOBAL", "GRAYBOARD_DELIVERY_LEASES_PER_USER",
  "GRAYBOARD_RESOURCE_WATCHES_GLOBAL", "GRAYBOARD_RESOURCE_WATCHES_PER_SESSION",
  "GRAYBOARD_HEALTHZ_LAG_P99_MS", "GRAYBOARD_HEALTHZ_LAG_WINDOWS",
  "GRAYBOARD_HOSTED_SESSIONS_PER_SERVICE", "GRAYBOARD_DELIVERY_LEASES_PER_SERVICE",
  ...["HOSTED_REQUEST_SERVICE", "HOSTED_SUBSCRIBER_SERVICE", "HELLO_SERVICE"].flatMap(p => [`GRAYBOARD_${p}_BURST`, `GRAYBOARD_${p}_PER_SEC`]),
  "GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS", "GRAYBOARD_SERVICE_TOKEN_MINTS_PER_MINUTE", "GRAYBOARD_SERVICE_TOKENS_UNEXPIRED",
  "GRAYBOARD_BLOB_S3_BUCKET", "GRAYBOARD_BLOB_S3_REGION", "GRAYBOARD_BLOB_S3_PREFIX", "GRAYBOARD_BLOB_S3_ENDPOINT",
  "AWS_REGION", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_SESSION_NAME", "AWS_ENDPOINT_URL_STS",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "S3_SESSION_TOKEN",
  "GRAYBOARD_DATABASE_CONNECT_SECONDS", "GRAYBOARD_DATABASE_WRITERS", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", ...FILE_SECRETS.map(name => `${name}_FILE`),
];

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.GRAYBOARD_DB_PATH = ":memory:";
    process.env.GRAYBOARD_PUBLIC_URL = "http://localhost:8080";
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

  test("dev auth needs a loopback public URL (#805 F-04)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    for (const url of ["https://grayboard.example.com", "http://10.0.0.5:8080", "http://localhost.example.com", "not a url"]) {
      process.env.GRAYBOARD_PUBLIC_URL = url;
      expect(() => loadConfig()).toThrow(/needs a loopback GRAYBOARD_PUBLIC_URL/);
    }
    for (const url of ["http://localhost", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      process.env.GRAYBOARD_PUBLIC_URL = url;
      expect(loadConfig().devAuth).toBe(true);
    }
  });

  function primary() {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "desktop-client";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "desktop-secret";
    process.env.GRAYBOARD_ORG_DOMAIN = "example.com";
  }

  // F-06: every cap can be raised past its default (the default was the ceiling), up to a typo guard.
  test("capacity caps are configurable upward, with each narrower cap beneath its server-wide one", () => {
    primary();
    const config = loadConfig();
    expect(config.mcpLimits).toEqual({ listen: { global: 128, perUser: 32 }, legacy: { global: 256, perUser: 32 }, post: { global: 256, perUser: 64 } });
    expect(config.hostedCaps).toEqual({ sessions: { global: 4096, perUser: 256, perService: 1024 }, leases: { global: 256, perUser: 32, perService: 64 }, watches: { global: 1024, perSession: 32 } });
    const families: [string, string, (c: ReturnType<typeof loadConfig>) => { global: number; scoped: number }][] = [
      ...(["listen", "legacy", "post"] as const).map(kind => [`GRAYBOARD_MCP_${kind.toUpperCase()}`, "PER_USER", (c: ReturnType<typeof loadConfig>) => ({ global: c.mcpLimits![kind].global, scoped: c.mcpLimits![kind].perUser })] as [string, string, (c: ReturnType<typeof loadConfig>) => { global: number; scoped: number }]),
      ["GRAYBOARD_HOSTED_SESSIONS", "PER_USER", c => ({ global: c.hostedCaps!.sessions.global, scoped: c.hostedCaps!.sessions.perUser })],
      ["GRAYBOARD_DELIVERY_LEASES", "PER_USER", c => ({ global: c.hostedCaps!.leases.global, scoped: c.hostedCaps!.leases.perUser })],
      // The service tier (#270 D4): clamped under the same global.
      ["GRAYBOARD_HOSTED_SESSIONS", "PER_SERVICE", c => ({ global: c.hostedCaps!.sessions.global, scoped: c.hostedCaps!.sessions.perService! })],
      ["GRAYBOARD_DELIVERY_LEASES", "PER_SERVICE", c => ({ global: c.hostedCaps!.leases.global, scoped: c.hostedCaps!.leases.perService! })],
      ["GRAYBOARD_RESOURCE_WATCHES", "PER_SESSION", c => ({ global: c.hostedCaps!.watches.global, scoped: c.hostedCaps!.watches.perSession })],
    ];
    for (const [prefix, scope, read] of families) {
      const scoped = `${prefix}_${scope}`;
      process.env[`${prefix}_GLOBAL`] = "50000"; process.env[scoped] = "5000";
      expect(read(loadConfig())).toEqual({ global: 50000, scoped: 5000 });
      process.env[`${prefix}_GLOBAL`] = "4"; process.env[scoped] = "2";
      expect(read(loadConfig())).toEqual({ global: 4, scoped: 2 });
      for (const value of ["0", "5", "1e3", " 2"]) {
        process.env[scoped] = value;
        expect(() => loadConfig()).toThrow(scoped);
      }
      delete process.env[scoped];
      expect(read(loadConfig()).scoped).toBe(4);
      process.env[`${prefix}_GLOBAL`] = "1000000";
      expect(read(loadConfig()).global).toBe(1000000);
      for (const value of ["0", "1000001", "1e3"]) {
        process.env[`${prefix}_GLOBAL`] = value;
        expect(() => loadConfig()).toThrow(`${prefix}_GLOBAL`);
      }
      delete process.env[`${prefix}_GLOBAL`];
    }
  });

  test("OAuth address and global rates use the shared configurable token-bucket bounds", () => {
    primary();
    expect(loadConfig()).toMatchObject({ oauthLimit: { burst: 60, perSec: 1 }, oauthGlobalLimit: { burst: 600, perSec: 10 } });
    for (const prefix of ["GRAYBOARD_OAUTH", "GRAYBOARD_OAUTH_GLOBAL"]) {
      process.env[prefix + "_BURST"] = "2";
      process.env[prefix + "_PER_SEC"] = "0.5";
      const config = loadConfig();
      expect(prefix.endsWith("GLOBAL") ? config.oauthGlobalLimit : config.oauthLimit).toEqual({ burst: 2, perSec: 0.5 });
      for (const value of ["0", "10001", "1e3"]) {
        process.env[prefix + "_BURST"] = value;
        expect(() => loadConfig()).toThrow(prefix + "_BURST");
      }
      process.env[prefix + "_BURST"] = "2";
      for (const value of ["0.01", "NaN", "-1"]) {
        process.env[prefix + "_PER_SEC"] = value;
        expect(() => loadConfig()).toThrow(prefix + "_PER_SEC");
      }
      delete process.env[prefix + "_BURST"]; delete process.env[prefix + "_PER_SEC"];
    }
  });

  // #1667: anyone by default; admins only when set; anything else refuses to start rather than leaving creation open.
  test("GRAYBOARD_TEAM_CREATE is anyone or admins", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().teamCreate).toBe("anyone");
    process.env.GRAYBOARD_TEAM_CREATE = "admins";
    expect(loadConfig().teamCreate).toBe("admins");
    process.env.GRAYBOARD_TEAM_CREATE = "admin";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_TEAM_CREATE must be "anyone" or "admins"/);
  });

  // #807: one of the path and the URL; the URL only with a blob directory.
  test("the store is a SQLite path or a Postgres URL", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().store).toEqual({ kind: "sqlite", path: ":memory:" });
    const url = "postgres://gb:s3cret@db.example.com:5432/grayboard";
    process.env.GRAYBOARD_DATABASE_URL = url;
    expect(() => loadConfig()).toThrow("Set one of GRAYBOARD_DATABASE_URL, GRAYBOARD_DB_PATH, not both");
    delete process.env.GRAYBOARD_DB_PATH;
    expect(() => loadConfig()).toThrow("GRAYBOARD_DATABASE_URL needs GRAYBOARD_BLOB_DIR");
    process.env.GRAYBOARD_BLOB_DIR = "/var/lib/grayboard/blobs";
    const config = loadConfig();
    expect(config.store).toEqual({ kind: "postgres", url });
    expect(config.blobDir).toBe("/var/lib/grayboard/blobs");
    // The startup line's description carries no credentials.
    expect(describeStore(config.store)).toBe("postgres db.example.com:5432/grayboard");
    expect(describeStore(config.store, { writers: undefined })).toBe("postgres db.example.com:5432/grayboard, 8 writers");
    expect(describeStore(config.store, { writers: 8, tls: "no TLS" })).toBe("postgres db.example.com:5432/grayboard, 8 writers, no TLS");
    expect(describeStore({ kind: "sqlite", path: "/x.db" }, { writers: 8 })).toBe("sqlite /x.db");
    expect(describeStore({ kind: "postgres", url: "not a url s3cret" })).not.toContain("s3cret");
    // Bun.SQL would pick another adapter from another scheme.
    process.env.GRAYBOARD_DATABASE_URL = "mysql://gb:s3cret@db.example.com/grayboard";
    expect(() => loadConfig()).toThrow("must start with postgres:// or postgresql://");
    process.env.GRAYBOARD_DATABASE_URL = "postgresql://gb@db.example.com/grayboard";
    expect(loadConfig().store.kind).toBe("postgres");
    delete process.env.GRAYBOARD_DATABASE_URL;
    expect(() => loadConfig()).toThrow("Required env var GRAYBOARD_DB_PATH (or GRAYBOARD_DATABASE_URL) is not set");
  });

  // #1418: the Postgres first-connection wait; unset leaves the store's default.
  test("GRAYBOARD_DATABASE_CONNECT_SECONDS is 0 to 3600 whole seconds", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().databaseConnectSeconds).toBeUndefined();
    for (const ok of ["0", "15", "3600"]) {
      process.env.GRAYBOARD_DATABASE_CONNECT_SECONDS = ok;
      expect(loadConfig().databaseConnectSeconds).toBe(Number(ok));
    }
    for (const bad of ["3601", "-1", "1.5", "015", " 5", "5s"]) {
      process.env.GRAYBOARD_DATABASE_CONNECT_SECONDS = bad;
      expect(() => loadConfig()).toThrow(`GRAYBOARD_DATABASE_CONNECT_SECONDS must be a whole number of seconds from 0 (one try) to 3600, not "${bad}"`);
    }
  });

  // #1510: the write pool's size and the write scheduler's cap; unset leaves the default (open_repo.ts).
  test("GRAYBOARD_DATABASE_WRITERS is 1 to 64 whole connections", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().databaseWriters).toBeUndefined();
    for (const ok of ["1", "8", "64"]) {
      process.env.GRAYBOARD_DATABASE_WRITERS = ok;
      expect(loadConfig().databaseWriters).toBe(Number(ok));
    }
    for (const bad of ["0", "65", "-1", "1.5", "08", " 4", "4x"]) {
      process.env.GRAYBOARD_DATABASE_WRITERS = bad;
      expect(() => loadConfig()).toThrow(`GRAYBOARD_DATABASE_WRITERS must be a whole number of connections from 1 to 64, not "${bad}"`);
    }
  });

  // #1418: a secret mounted as a file (Docker, Kubernetes) reads as its variable, before any check sees it.
  test("NAME_FILE supplies a secret from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-secrets-"));
    try {
      const file = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, body); return path; };
      process.env.GRAYBOARD_DEV_AUTH = "1";
      delete process.env.GRAYBOARD_DB_PATH;
      process.env.GRAYBOARD_BLOB_DIR = "/var/lib/grayboard/blobs";
      const url = "postgres://gb:s3cret@db.example.com:5432/grayboard";
      // The trailing line break an editor or `echo` leaves is not part of the secret.
      process.env.GRAYBOARD_DATABASE_URL_FILE = file("db-url", `${url}\r\n`);
      expect(loadConfig().store).toEqual({ kind: "postgres", url });
      // Resolution leaves NAME set; loading again reads the same value rather than seeing two sources.
      expect(loadConfig().store).toEqual({ kind: "postgres", url });
      // Both forms is a refusal, not a precedence rule.
      process.env.GRAYBOARD_DATABASE_URL = "postgres://gb:other@db.example.com:5432/grayboard";
      expect(() => loadConfig()).toThrow("Set one of GRAYBOARD_DATABASE_URL, GRAYBOARD_DATABASE_URL_FILE, not both");
      delete process.env.GRAYBOARD_DATABASE_URL;
      process.env.GRAYBOARD_DATABASE_URL_FILE = file("empty", "\n");
      expect(() => loadConfig()).toThrow(`GRAYBOARD_DATABASE_URL_FILE: ${join(dir, "empty")} is empty`);
      process.env.GRAYBOARD_DATABASE_URL_FILE = join(dir, "missing");
      expect(() => loadConfig()).toThrow(`GRAYBOARD_DATABASE_URL_FILE: cannot read ${join(dir, "missing")}: ENOENT`);
      process.env.GRAYBOARD_DATABASE_URL_FILE = file("db-url", url);
      expect(loadConfig().store).toEqual({ kind: "postgres", url });
      delete process.env.GRAYBOARD_DATABASE_URL;

      // A file-borne client secret still trips the dev-auth guard: resolution runs before every check.
      process.env.GRAYBOARD_DATABASE_URL_FILE = file("db-url", url);
      process.env.GRAYBOARD_OKTA_CLIENT_SECRET_FILE = file("okta", "okta-secret\n");
      expect(() => loadConfig()).toThrow("GRAYBOARD_DEV_AUTH=1 must not be set alongside");
      delete process.env.GRAYBOARD_OKTA_CLIENT_SECRET_FILE;
      delete process.env.GRAYBOARD_OKTA_CLIENT_SECRET;
      delete process.env.GRAYBOARD_DATABASE_URL;

      process.env.SLACK_APP_TOKEN_FILE = file("app", "xapp-1\n");
      process.env.SLACK_BOT_TOKEN_FILE = file("bot", "xoxb-1\n");
      expect(loadConfig().slack).toEqual({ appToken: "xapp-1", botToken: "xoxb-1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #928 D6/D8: one pair. The primary is required only when the MCP pair is absent; with both set (a Desktop
  // primary and a Web MCP pair) the MCP pair is the AS's and the primary goes unused.
  test("the primary Google pair is required only without the MCP pair", () => {
    primary();
    expect(loadConfig().mcpGoogle).toBeUndefined();
    for (const name of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]) {
      delete process.env[name];
      expect(() => loadConfig()).toThrow(`Required env var ${name} is not set`);
      primary();
    }
    process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_ID = "web-client";
    process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET = "web-secret";
    expect(loadConfig()).toMatchObject({ googleClientId: "desktop-client", googleClientSecret: "desktop-secret", mcpGoogle: { clientId: "web-client", clientSecret: "web-secret" } });
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(loadConfig()).toMatchObject({ googleClientId: "", googleClientSecret: "", mcpGoogle: { clientId: "web-client", clientSecret: "web-secret" } });
  });

  test("half, empty and malformed MCP Google pairs fail without exposing credentials", () => {
    primary();
    for (const [id, secret] of [["web-client", undefined], [undefined, "private-secret"], ["", "private-secret"], ["web-client", ""], ["", ""], ["bad client", "private-secret"], ["web-client", "private-secret\n"], ["web-client", "x".repeat(4097)]]) {
      delete process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_ID;
      delete process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET;
      if (id !== undefined) process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_ID = id;
      if (secret !== undefined) process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET = secret;
      let message = "";
      try { loadConfig(); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("set both GRAYBOARD_MCP_GOOGLE_CLIENT_ID");
      expect(message).not.toContain("private-secret");
      expect(message).not.toContain("web-client");
    }
  });

  // #928 D6: the provider list and Okta's four variables.
  function okta() {
    process.env.GRAYBOARD_OKTA_ISSUER = "https://example.okta.com";
    process.env.GRAYBOARD_OKTA_CLIENT_ID = "okta-client";
    process.env.GRAYBOARD_OKTA_CLIENT_SECRET = "okta-private";
    process.env.GRAYBOARD_OKTA_ALLOWED_DOMAINS = "Example.com, corp.example.org";
  }
  const message = () => { try { loadConfig(); return ""; } catch (e) { return (e as Error).message; } };

  test("GRAYBOARD_IDPS defaults to google alone: an existing deployment's env is unchanged", () => {
    primary();
    expect(loadConfig()).toMatchObject({ idps: ["google"], googleClientId: "desktop-client", googleClientSecret: "desktop-secret", orgDomain: "example.com" });
    expect(loadConfig().okta).toBeUndefined();
    process.env.GRAYBOARD_IDPS = "google";
    expect(loadConfig().idps).toEqual(["google"]);
  });

  test("an Okta-only server needs neither Google's variables nor GRAYBOARD_ORG_DOMAIN", () => {
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    expect(loadConfig()).toMatchObject({ idps: ["okta"], googleClientId: "", googleClientSecret: "", orgDomain: "",
      okta: { issuer: "https://example.okta.com", clientId: "okta-client", clientSecret: "okta-private", allowedDomains: ["example.com", "corp.example.org"] } });
    // Google's variables, set but unlisted, go unread.
    primary();
    expect(loadConfig()).toMatchObject({ googleClientId: "", googleClientSecret: "", orgDomain: "" });
  });

  test("Google and Okta together keep the listed order and need both providers' variables", () => {
    process.env.GRAYBOARD_IDPS = "okta, google";
    okta();
    expect(message()).toBe("Required env var GOOGLE_OAUTH_CLIENT_ID is not set");
    primary();
    expect(loadConfig()).toMatchObject({ idps: ["okta", "google"], googleClientId: "desktop-client", okta: { clientId: "okta-client" } });
    delete process.env.GRAYBOARD_ORG_DOMAIN;
    expect(message()).toBe("Required env var GRAYBOARD_ORG_DOMAIN is not set");
  });

  test("an unknown, repeated or empty provider list refuses to start", () => {
    primary();
    for (const [raw, error] of [["", "empty entry"], [",", "empty entry"], ["google,", "empty entry"], ["azure", 'unknown provider "azure"'], ["Google", 'unknown provider "Google"'], ["google,google", "lists a provider twice"]]) {
      process.env.GRAYBOARD_IDPS = raw;
      expect(message()).toContain(error);
    }
  });

  test("okta listed refuses to start without each of its four variables", () => {
    process.env.GRAYBOARD_IDPS = "okta";
    for (const name of ["GRAYBOARD_OKTA_ISSUER", "GRAYBOARD_OKTA_CLIENT_ID", "GRAYBOARD_OKTA_CLIENT_SECRET", "GRAYBOARD_OKTA_ALLOWED_DOMAINS"]) {
      okta();
      delete process.env[name];
      expect(message()).toBe(`GRAYBOARD_IDPS lists okta, so ${name} is required`);
      process.env[name] = "";
      expect(message()).toBe(`GRAYBOARD_IDPS lists okta, so ${name} is required`);
    }
  });

  test("checkIdpConfig on Config alone refuses Okta config with okta unlisted, and okta listed without its config", () => {
    const okta = { issuer: "https://example.okta.com", clientId: "okta-client", clientSecret: "okta-private", allowedDomains: ["example.com"] };
    const base = { devAuth: false, googleClientSecret: "" };
    expect(() => checkIdpConfig({ ...base, idps: ["google"], okta })).toThrow("Okta is configured but GRAYBOARD_IDPS doesn't list okta");
    expect(() => checkIdpConfig({ ...base, idps: ["okta"], okta: undefined })).toThrow("GRAYBOARD_IDPS lists okta without its configuration");
    expect(() => checkIdpConfig({ ...base, idps: ["okta"], okta })).not.toThrow();
  });

  test("an Okta variable set while okta isn't listed refuses to start", () => {
    primary();
    for (const name of ["GRAYBOARD_OKTA_ISSUER", "GRAYBOARD_OKTA_CLIENT_ID", "GRAYBOARD_OKTA_CLIENT_SECRET", "GRAYBOARD_OKTA_ALLOWED_DOMAINS"]) {
      process.env[name] = "set";
      expect(message()).toBe(`${name} set but GRAYBOARD_IDPS doesn't list okta: list it, or unset them`);
      delete process.env[name];
    }
  });

  test("the Okta issuer must be https, without a query, fragment or trailing slash, and not Google's", () => {
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    for (const issuer of ["http://example.okta.com", "https://example.okta.com/", "https://example.okta.com/oauth2/default/", "https://example.okta.com?x=1", "https://example.okta.com#f", "https://user:pw@example.okta.com", "example.okta.com", "not a url"]) {
      process.env.GRAYBOARD_OKTA_ISSUER = issuer;
      expect(message()).toContain("GRAYBOARD_OKTA_ISSUER must be an https URL");
    }
    process.env.GRAYBOARD_OKTA_ISSUER = "https://accounts.google.com";
    expect(message()).toBe("GRAYBOARD_OKTA_ISSUER can't be Google's issuer");
    process.env.GRAYBOARD_OKTA_ISSUER = "https://example.okta.com/oauth2/default";
    expect(loadConfig().okta!.issuer).toBe("https://example.okta.com/oauth2/default");
  });

  test("a malformed Okta domain or credential refuses to start, without quoting the credential", () => {
    process.env.GRAYBOARD_IDPS = "okta";
    for (const domains of ["example", "@example.com", "example.com,", "ex ample.com", "-example.com", "example.com/x", "you@example.com"]) {
      okta();
      process.env.GRAYBOARD_OKTA_ALLOWED_DOMAINS = domains;
      expect(message()).toContain("GRAYBOARD_OKTA_ALLOWED_DOMAINS must be email domains");
    }
    for (const [id, secret] of [["okta client", "okta-private"], ["okta-client", "okta private"], ["okta-client", "x".repeat(4097)]]) {
      okta();
      process.env.GRAYBOARD_OKTA_CLIENT_ID = id!;
      process.env.GRAYBOARD_OKTA_CLIENT_SECRET = secret!;
      const text = message();
      expect(text).toContain("must be nonempty credentials without whitespace");
      expect(text).not.toContain("private");
    }
  });

  // #1418: the generic provider, confidential or public.
  function oidc() {
    process.env.GRAYBOARD_OIDC_ISSUER = "https://sso.example.com/realms/eng";
    process.env.GRAYBOARD_OIDC_CLIENT_ID = "grayboard";
    process.env.GRAYBOARD_OIDC_ALLOWED_DOMAINS = "Example.com";
  }

  test("oidc without a secret is a public client, under the default label", () => {
    process.env.GRAYBOARD_IDPS = "oidc";
    oidc();
    const c = loadConfig();
    expect(c).toMatchObject({ idps: ["oidc"], googleClientId: "", orgDomain: "" });
    expect(c.oidc).toEqual({ issuer: "https://sso.example.com/realms/eng", clientId: "grayboard", allowedDomains: ["example.com"], label: "Single sign-on" });
  });

  test("oidc with a secret and a label is a confidential client, beside Okta and Google in the listed order", () => {
    process.env.GRAYBOARD_IDPS = "oidc, okta, google";
    oidc();
    okta();
    primary();
    process.env.GRAYBOARD_OIDC_CLIENT_SECRET = "oidc-private";
    process.env.GRAYBOARD_OIDC_LABEL = "Example SSO";
    expect(loadConfig()).toMatchObject({ idps: ["oidc", "okta", "google"], oidc: { clientSecret: "oidc-private", label: "Example SSO" }, okta: { clientId: "okta-client" } });
  });

  test("the oidc secret can come from a file, making a confidential client", () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-oidc-"));
    try {
      const path = join(dir, "oidc");
      writeFileSync(path, "oidc-private\n");
      process.env.GRAYBOARD_IDPS = "oidc";
      oidc();
      process.env.GRAYBOARD_OIDC_CLIENT_SECRET_FILE = path;
      expect(loadConfig().oidc).toMatchObject({ clientSecret: "oidc-private" });
      // An empty path is refused, never read as "no secret" (a public client).
      delete process.env.GRAYBOARD_OIDC_CLIENT_SECRET;
      process.env.GRAYBOARD_OIDC_CLIENT_SECRET_FILE = "";
      expect(() => loadConfig()).toThrow("GRAYBOARD_OIDC_CLIENT_SECRET_FILE is set but empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty oidc secret refuses to start rather than become a public client", () => {
    process.env.GRAYBOARD_IDPS = "oidc";
    oidc();
    process.env.GRAYBOARD_OIDC_CLIENT_SECRET = "";
    expect(message()).toBe("GRAYBOARD_OIDC_CLIENT_ID and GRAYBOARD_OIDC_CLIENT_SECRET must be nonempty credentials without whitespace");
  });

  test("oidc listed needs its three variables, and any of its five set while it isn't refuses to start", () => {
    process.env.GRAYBOARD_IDPS = "oidc";
    for (const name of ["GRAYBOARD_OIDC_ISSUER", "GRAYBOARD_OIDC_CLIENT_ID", "GRAYBOARD_OIDC_ALLOWED_DOMAINS"]) {
      oidc();
      delete process.env[name];
      expect(message()).toBe(`GRAYBOARD_IDPS lists oidc, so ${name} is required`);
    }
    delete process.env.GRAYBOARD_IDPS;
    primary();
    for (const name of ["GRAYBOARD_OIDC_ISSUER", "GRAYBOARD_OIDC_CLIENT_ID", "GRAYBOARD_OIDC_CLIENT_SECRET", "GRAYBOARD_OIDC_ALLOWED_DOMAINS", "GRAYBOARD_OIDC_LABEL"]) {
      for (const k of ["GRAYBOARD_OIDC_ISSUER", "GRAYBOARD_OIDC_CLIENT_ID", "GRAYBOARD_OIDC_CLIENT_SECRET", "GRAYBOARD_OIDC_ALLOWED_DOMAINS", "GRAYBOARD_OIDC_LABEL"]) delete process.env[k];
      process.env[name] = "x";
      expect(message()).toBe(`${name} set but GRAYBOARD_IDPS doesn't list oidc: list it, or unset them`);
    }
  });

  test("the oidc issuer, domains and label are checked as Okta's are, and its issuer can't be Okta's", () => {
    process.env.GRAYBOARD_IDPS = "oidc";
    for (const issuer of ["http://sso.example.com", "https://sso.example.com/", "https://sso.example.com?x=1", "https://accounts.google.com"]) {
      oidc();
      process.env.GRAYBOARD_OIDC_ISSUER = issuer;
      expect(message()).toMatch(/^GRAYBOARD_OIDC_ISSUER (must be an https URL|can't be Google's issuer)/);
    }
    oidc();
    process.env.GRAYBOARD_OIDC_ALLOWED_DOMAINS = "example";
    expect(message()).toContain("GRAYBOARD_OIDC_ALLOWED_DOMAINS must be email domains");
    for (const label of ["", " ", "x".repeat(65), "a\nb"]) {
      oidc();
      process.env.GRAYBOARD_OIDC_LABEL = label;
      expect(message()).toBe("GRAYBOARD_OIDC_LABEL must be 1 to 64 characters on one line");
    }
    delete process.env.GRAYBOARD_OIDC_LABEL;
    oidc();
    okta();
    process.env.GRAYBOARD_IDPS = "oidc,okta";
    process.env.GRAYBOARD_OIDC_ISSUER = process.env.GRAYBOARD_OKTA_ISSUER;
    expect(message()).toBe("GRAYBOARD_OIDC_ISSUER can't be GRAYBOARD_OKTA_ISSUER");
  });

  test("dev auth refuses to start alongside an oidc issuer, though a public client has no secret", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_IDPS = "oidc";
    oidc();
    expect(message()).toBe("GRAYBOARD_DEV_AUTH=1 must not be set alongside GRAYBOARD_OIDC_ISSUER (prevents prod misconfig)");
    const config = { idps: ["oidc" as const], devAuth: true, googleClientSecret: "", oidc: { issuer: "https://sso.example.com", clientId: "grayboard", allowedDomains: ["example.com"], label: "SSO" } };
    expect(() => checkIdpConfig(config)).toThrow("dev auth must not coexist");
    expect(() => checkIdpConfig({ ...config, devAuth: false })).not.toThrow();
  });

  test("dev auth refuses to start alongside the Okta client secret", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    expect(message()).toContain("GRAYBOARD_DEV_AUTH=1 must not be set alongside");
    expect(message()).not.toContain("okta-private");
  });

  test("dev auth rejects the independent MCP Google secret", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_ID = "web-client";
    process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET = "private-secret";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_DEV_AUTH=1/);
  });

  test("dev auth starts without Google credentials", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().devAuth).toBe(true);
  });

  test("hosted request limits are independently configured and validated", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().hostedRequestLimit).toEqual({ burst: 120, perSec: 20 });
    process.env.GRAYBOARD_HOSTED_REQUEST_BURST = "240";
    process.env.GRAYBOARD_HOSTED_REQUEST_PER_SEC = "40";
    expect(loadConfig().hostedRequestLimit).toEqual({ burst: 240, perSec: 40 });
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_HOSTED_REQUEST_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HOSTED_REQUEST_BURST/);
    process.env.GRAYBOARD_HOSTED_REQUEST_BURST = "120";
    process.env.GRAYBOARD_HOSTED_REQUEST_PER_SEC = "0";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HOSTED_REQUEST_PER_SEC/);
  });

  test("a service's buckets and its run tokens' bounds are configured apart from a user's (#270 D2, D4)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().serviceLimits).toEqual({ hostedRequest: { burst: 480, perSec: 80 }, hostedSubscriber: { burst: 960, perSec: 160 }, bind: { burst: 240, perSec: 4 } });
    expect(loadConfig().serviceTokens).toEqual({ maxSeconds: 86_400, mintsPerMinute: 60, unexpired: 1000 });
    process.env.GRAYBOARD_HOSTED_REQUEST_SERVICE_BURST = "900";
    process.env.GRAYBOARD_HELLO_SERVICE_PER_SEC = "8";
    process.env.GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS = "600";
    process.env.GRAYBOARD_SERVICE_TOKEN_MINTS_PER_MINUTE = "5";
    process.env.GRAYBOARD_SERVICE_TOKENS_UNEXPIRED = "7";
    const c = loadConfig();
    expect(c.serviceLimits).toMatchObject({ hostedRequest: { burst: 900, perSec: 80 }, bind: { burst: 240, perSec: 8 } });
    expect(c.hostedRequestLimit).toEqual({ burst: 120, perSec: 20 });
    expect(c.serviceTokens).toEqual({ maxSeconds: 600, mintsPerMinute: 5, unexpired: 7 });
    // Below the mint bucket's minute the window could undercount; above a year is a typo.
    for (const v of ["59", "31622401", "0"]) {
      process.env.GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS = v;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS/);
    }
  });

  test("the subscriber request bucket is configured apart from the tool-call one (#845)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().hostedSubscriberLimit).toEqual({ burst: 240, perSec: 40 });
    process.env.GRAYBOARD_HOSTED_SUBSCRIBER_BURST = "480";
    process.env.GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC = "80";
    expect(loadConfig().hostedSubscriberLimit).toEqual({ burst: 480, perSec: 80 });
    expect(loadConfig().hostedRequestLimit).toEqual({ burst: 120, perSec: 20 });
    process.env.GRAYBOARD_HOSTED_SUBSCRIBER_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HOSTED_SUBSCRIBER_BURST/);
    process.env.GRAYBOARD_HOSTED_SUBSCRIBER_BURST = "240";
    process.env.GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC = "0";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC/);
  });

  test("GRAYBOARD_ADMINS is a trimmed, lowercased email list; unset means none", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().admins).toEqual([]);
    process.env.GRAYBOARD_ADMINS = " Alice@Example.com, bob@example.com ,,";
    expect(loadConfig().admins).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("attachment bytes go in blobs/ beside the database unless GRAYBOARD_BLOB_DIR says otherwise", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_DB_PATH = "/var/lib/grayboard/bus.db";
    expect(loadConfig().blobDir).toBe("/var/lib/grayboard/blobs");
    process.env.GRAYBOARD_BLOB_DIR = "/srv/blobs";
    expect(loadConfig().blobDir).toBe("/srv/blobs");
  });

  // #1509: an S3 bucket in place of a blob directory, on either store.
  test("GRAYBOARD_BLOB_S3_BUCKET keeps attachments in S3 instead of a directory, with its region, prefix and endpoint", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_BLOB_S3_BUCKET = "example-bucket";
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "example-secret";
    expect(() => loadConfig()).toThrow("GRAYBOARD_BLOB_S3_BUCKET needs a region: set GRAYBOARD_BLOB_S3_REGION (or AWS_REGION)");
    process.env.AWS_REGION = "us-west-2";
    let config = loadConfig();
    expect(config.blobDir).toBeUndefined();
    expect(config.blobS3).toEqual({ bucket: "example-bucket", region: "us-west-2", prefix: "", credentials: { kind: "static", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" } });
    process.env.GRAYBOARD_BLOB_S3_REGION = "eu-central-1";
    process.env.GRAYBOARD_BLOB_S3_PREFIX = "grayboard/blobs";
    process.env.GRAYBOARD_BLOB_S3_ENDPOINT = "http://127.0.0.1:9000";
    process.env.AWS_SESSION_TOKEN = "example-session";
    config = loadConfig();
    expect(config.blobS3).toEqual({ bucket: "example-bucket", region: "eu-central-1", prefix: "grayboard/blobs/", endpoint: "http://127.0.0.1:9000", credentials: { kind: "static", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret", sessionToken: "example-session" } });
    // The startup line names where and how, never a key.
    const line = describeBlobs(config);
    expect(line).toBe("s3://example-bucket/grayboard/blobs/ (eu-central-1, endpoint http://127.0.0.1:9000; static keys)");
    for (const secret of ["AKIAEXAMPLE", "example-secret", "example-session"]) expect(line).not.toContain(secret);
    expect(describeBlobs({ blobDir: "/srv/blobs" })).toBe("directory /srv/blobs");
    // Prefixes S3 takes as written: dots inside a segment, its other safe characters, a trailing "/".
    for (const [ok, normalized] of [["a.b/c-d_e/", "a.b/c-d_e/"], ["x!*'()", "x!*'()/"], ["..a/b..", "..a/b../"]]) {
      process.env.GRAYBOARD_BLOB_S3_PREFIX = ok;
      expect(loadConfig().blobS3?.prefix).toBe(normalized);
    }
    process.env.GRAYBOARD_BLOB_S3_PREFIX = "grayboard/blobs";
    // One place for attachments.
    process.env.GRAYBOARD_BLOB_DIR = "/srv/blobs";
    expect(() => loadConfig()).toThrow("Set one of GRAYBOARD_BLOB_S3_BUCKET, GRAYBOARD_BLOB_DIR, not both");
    delete process.env.GRAYBOARD_BLOB_DIR;
    for (const [name, bad, refusal] of [
      ["GRAYBOARD_BLOB_S3_BUCKET", "Example_Bucket", "GRAYBOARD_BLOB_S3_BUCKET must be an S3 bucket name"],
      ["GRAYBOARD_BLOB_S3_PREFIX", "/blobs", "GRAYBOARD_BLOB_S3_PREFIX must not start with \"/\""],
      ...["../other-bucket/x", "a/../b", "a/./b", "a/..", ".", "a//b", "a b", "a\\b", "a?b", "a#b", "a%2e%2e/b", "ü/x"].map(bad =>
        ["GRAYBOARD_BLOB_S3_PREFIX", bad, "GRAYBOARD_BLOB_S3_PREFIX must be \"/\"-separated segments"] as const),
      ["GRAYBOARD_BLOB_S3_ENDPOINT", "https://user:pass@s3.example.com", "GRAYBOARD_BLOB_S3_ENDPOINT must not carry credentials"],
      ["GRAYBOARD_BLOB_S3_ENDPOINT", "https://user@s3.example.com", "GRAYBOARD_BLOB_S3_ENDPOINT must not carry credentials"],
      ["GRAYBOARD_BLOB_S3_ENDPOINT", "ftp://example.com", "GRAYBOARD_BLOB_S3_ENDPOINT must be an http(s) URL"],
      ["GRAYBOARD_BLOB_S3_ENDPOINT", "not a url", "GRAYBOARD_BLOB_S3_ENDPOINT must be an http(s) URL"],
      ["GRAYBOARD_BLOB_S3_REGION", "us-east-1.evil", "the S3 region must be an AWS region name"],
    ] as const) {
      const was = process.env[name];
      process.env[name] = bad;
      expect(() => loadConfig()).toThrow(refusal);
      process.env[name] = was;
    }
  });

  test("an empty GRAYBOARD_BLOB_S3_BUCKET is unset, but the store's other S3 variables without it are refused", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_DB_PATH = "/var/lib/grayboard/bus.db";
    process.env.GRAYBOARD_BLOB_S3_BUCKET = "";
    expect(loadConfig()).toMatchObject({ blobDir: "/var/lib/grayboard/blobs" });
    expect(loadConfig().blobS3).toBeUndefined();
    for (const name of ["GRAYBOARD_BLOB_S3_REGION", "GRAYBOARD_BLOB_S3_PREFIX", "GRAYBOARD_BLOB_S3_ENDPOINT"]) {
      process.env[name] = "x";
      expect(() => loadConfig()).toThrow(`${name} is set without GRAYBOARD_BLOB_S3_BUCKET`);
      delete process.env[name];
    }
  });

  test("a Postgres store with an S3 bucket needs no blob directory", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    delete process.env.GRAYBOARD_DB_PATH;
    process.env.GRAYBOARD_DATABASE_URL = "postgres://gb@db.example.com/grayboard";
    expect(() => loadConfig()).toThrow("GRAYBOARD_DATABASE_URL needs GRAYBOARD_BLOB_DIR or GRAYBOARD_BLOB_S3_BUCKET");
    process.env.GRAYBOARD_BLOB_S3_BUCKET = "example-bucket";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "example-secret";
    const config = loadConfig();
    expect(config.store).toEqual({ kind: "postgres", url: "postgres://gb@db.example.com/grayboard" });
    expect(config.blobDir).toBeUndefined();
    expect(config.blobS3?.bucket).toBe("example-bucket");
  });

  test("S3 credentials: the pod's web identity before static keys; half a pair, or none, is refused", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    process.env.GRAYBOARD_BLOB_S3_BUCKET = "example-bucket";
    process.env.GRAYBOARD_BLOB_S3_REGION = "us-east-1";
    expect(() => loadConfig()).toThrow("GRAYBOARD_BLOB_S3_BUCKET needs AWS credentials: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN");
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
    expect(() => loadConfig()).toThrow("set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
    process.env.AWS_SECRET_ACCESS_KEY = "example-secret";
    expect(loadConfig().blobS3?.credentials.kind).toBe("static");
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/grayboard";
    expect(() => loadConfig()).toThrow("set both AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN");
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/eks.amazonaws.com/serviceaccount/token";
    // STS in the pod's region (EKS injects AWS_REGION), else the bucket's; a fresh session name per process.
    let creds = loadConfig().blobS3!.credentials;
    expect(creds).toMatchObject({ kind: "web-identity", roleArn: "arn:aws:iam::123456789012:role/grayboard", tokenFile: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token", stsEndpoint: "https://sts.us-east-1.amazonaws.com/" });
    expect(creds.kind === "web-identity" && creds.sessionName).toMatch(/^grayboard-[0-9a-f]{12}$/);
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_ROLE_SESSION_NAME = "gb-pod-1";
    creds = loadConfig().blobS3!.credentials;
    expect(creds).toMatchObject({ stsEndpoint: "https://sts.us-west-2.amazonaws.com/", sessionName: "gb-pod-1" });
    process.env.AWS_ENDPOINT_URL_STS = "http://127.0.0.1:4566/";
    expect(loadConfig().blobS3!.credentials).toMatchObject({ stsEndpoint: "http://127.0.0.1:4566/" });
    expect(describeBlobs(loadConfig())).toBe("s3://example-bucket/ (us-east-1; web identity, role arn:aws:iam::123456789012:role/grayboard)");
    // Bun's client would sign with S3_SESSION_TOKEN where it's handed no token, read as the process started.
    process.env.S3_SESSION_TOKEN = "stray";
    expect(() => loadConfig()).toThrow("S3_SESSION_TOKEN is set");
  });

  test("attachment limits default to local mode's; set, they must be byte counts with the file cap within the total", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().attachmentLimits).toEqual({ file: 10 * 1024 * 1024, total: 25 * 1024 * 1024 });
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "1000";
    process.env.GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES = "3000";
    expect(loadConfig().attachmentLimits).toEqual({ file: 1000, total: 3000 });
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "10MB";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_BYTES must be a positive whole number of bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "4000";
    expect(() => loadConfig()).toThrow(/can't exceed GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES/);
  });

  test("the hosted idle window is unset by default; set, it must be plain digits (#387 item 10)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().hostedIdleSeconds).toBeUndefined();
    process.env.GRAYBOARD_HOSTED_IDLE_SECONDS = "600";
    expect(loadConfig().hostedIdleSeconds).toBe(600);
    for (const bad of [" 900 ", "1e3", "0", "1.5", "-3"]) {
      process.env.GRAYBOARD_HOSTED_IDLE_SECONDS = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HOSTED_IDLE_SECONDS must be a positive whole number of seconds/);
    }
  });

  test("the /healthz lag gate defaults to 1000 ms over 3 windows; 0 ms turns it off; else plain digits within bounds (#805)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().healthzLag).toEqual({ p99Ms: 1000, windows: 3 });
    process.env.GRAYBOARD_HEALTHZ_LAG_P99_MS = "0";
    expect(loadConfig().healthzLag?.p99Ms).toBe(0);
    process.env.GRAYBOARD_HEALTHZ_LAG_P99_MS = "250";
    process.env.GRAYBOARD_HEALTHZ_LAG_WINDOWS = "60";
    expect(loadConfig().healthzLag).toEqual({ p99Ms: 250, windows: 60 });
    process.env.GRAYBOARD_HEALTHZ_LAG_WINDOWS = "61";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HEALTHZ_LAG_WINDOWS can be at most 60 windows/);
    for (const bad of ["0", "1.5", " 3", "-1"]) {
      process.env.GRAYBOARD_HEALTHZ_LAG_WINDOWS = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HEALTHZ_LAG_WINDOWS must be a positive whole number of windows/);
    }
    delete process.env.GRAYBOARD_HEALTHZ_LAG_WINDOWS;
    for (const bad of ["00", "1e3", "-5", "600001"]) {
      process.env.GRAYBOARD_HEALTHZ_LAG_P99_MS = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HEALTHZ_LAG_P99_MS (must be a positive whole number|can be at most)/);
    }
  });

  test("CLI token idle days default to 30; 0 means never; else plain digits up to 3650 (security audit F-14)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().cliTokenIdleDays).toBe(30);
    for (const [raw, days] of [["", 30], ["0", 0], ["7", 7], ["3650", 3650]] as const) {
      process.env.GRAYBOARD_CLI_TOKEN_IDLE_DAYS = raw;
      expect(loadConfig().cliTokenIdleDays).toBe(days);
    }
    for (const bad of [" 7", "07", "1e2", "1.5", "-1", "3651", "never"]) {
      process.env.GRAYBOARD_CLI_TOKEN_IDLE_DAYS = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_CLI_TOKEN_IDLE_DAYS must be a whole number of days/);
    }
  });

  test("IdP re-auth days default to 30; 0 means never; else plain digits up to 3650 (#930)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().idpReauthDays).toBe(30);
    for (const [raw, days] of [["", 30], ["0", 0], ["1", 1], ["3650", 3650]] as const) {
      process.env.GRAYBOARD_IDP_REAUTH_DAYS = raw;
      expect(loadConfig().idpReauthDays).toBe(days);
    }
    for (const bad of [" 7", "07", "1e2", "1.5", "-1", "3651", "never"]) {
      process.env.GRAYBOARD_IDP_REAUTH_DAYS = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_IDP_REAUTH_DAYS must be a whole number of days/);
    }
  });

  test("the IdP re-check defaults to 24 h, 72 h stale and 5 disables an hour; the stale bound is at least the interval (#930 A2)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().idpRecheck).toEqual({ recheckHours: 24, maxStaleHours: 72, disableLimit: 5 });
    process.env.GRAYBOARD_IDP_RECHECK_HOURS = "6";
    process.env.GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS = "6";
    process.env.GRAYBOARD_IDP_DISABLE_LIMIT = "20";
    expect(loadConfig().idpRecheck).toEqual({ recheckHours: 6, maxStaleHours: 6, disableLimit: 20 });
    process.env.GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS = "5";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS \(5\) must be at least GRAYBOARD_IDP_RECHECK_HOURS \(6\)/);
    process.env.GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS = "";
    for (const [name, bad] of [["GRAYBOARD_IDP_RECHECK_HOURS", "0"], ["GRAYBOARD_IDP_RECHECK_HOURS", "06"], ["GRAYBOARD_IDP_DISABLE_LIMIT", "0"], ["GRAYBOARD_IDP_DISABLE_LIMIT", "1.5"]] as const) {
      const was = process.env[name];
      process.env[name] = bad;
      expect(() => loadConfig()).toThrow(new RegExp(`${name} must be a whole number`));
      process.env[name] = was;
    }
  });

  test("the startup line names the re-auth window and every provider with no directory check (#930)", () => {
    expect(describeReauth({})).toBe("sign-in every 30 days (no directory check: google)");
    expect(describeReauth({ idps: ["google", "oidc"], idpReauthDays: 7 })).toBe("sign-in every 7 days (no directory check: google, oidc)");
    expect(describeReauth({ idps: ["oidc"], idpReauthDays: 0 })).toBe("off (GRAYBOARD_IDP_REAUTH_DAYS=0; no directory check: oidc)");
  });

  test("with a Google directory key the startup line names Google's check, and the clock only for the rest (#930 A2b)", () => {
    const dir = { kind: "key" as const, clientEmail: "sa@p.iam.gserviceaccount.com", privateKey: "k" };
    expect(describeReauth({ googleDirectory: dir })).toBe("directory check every 24 h (google)");
    expect(describeReauth({ idps: ["okta", "google"], googleDirectory: dir, idpRecheck: { recheckHours: 6, maxStaleHours: 72, disableLimit: 5 } }))
      .toBe("directory check every 6 h (google); sign-in every 30 days (no directory check: okta)");
    expect(describeReauth({ idps: ["google", "okta"], googleDirectory: dir, idpReauthDays: 0 }))
      .toBe("directory check every 24 h (google); off (GRAYBOARD_IDP_REAUTH_DAYS=0; no directory check: okta)");
    const kc = { baseUrl: "https://sso.example.com", realm: "eng", clientId: "c", clientSecret: "s" };
    expect(describeReauth({ idps: ["oidc", "google"], keycloakDirectory: kc }))
      .toBe("directory check every 24 h (oidc); sign-in every 30 days (no directory check: google)");
    expect(describeReauth({ idps: ["google", "oidc"], googleDirectory: dir, keycloakDirectory: kc })).toBe("directory check every 24 h (google, oidc)");
    const ok = { orgUrl: "https://example.okta.com", clientId: "0oa1", privateKey: "k", alg: "RS256" };
    expect(describeReauth({ idps: ["okta", "google"], oktaDirectory: ok })).toBe("directory check every 24 h (okta); sign-in every 30 days (no directory check: google)");
    expect(describeReauth({ idps: ["okta", "oidc"], oktaDirectory: ok, keycloakDirectory: kc })).toBe("directory check every 24 h (okta, oidc)");
  });

  test("GRAYBOARD_GOOGLE_DIRECTORY_KEY turns on Google's directory check; half a configuration refuses to start (#930 A2b)", () => {
    primary();
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const key = JSON.stringify({ type: "service_account", client_email: "sa@p.iam.gserviceaccount.com", private_key: pem });
    expect(loadConfig().googleDirectory).toBeUndefined();
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_ADMIN = "admin@example.com";
    expect(message()).toBe("GRAYBOARD_GOOGLE_DIRECTORY_ADMIN is set without GRAYBOARD_GOOGLE_DIRECTORY_KEY or GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT");
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY = key;
    expect(loadConfig().googleDirectory).toEqual({ kind: "key", clientEmail: "sa@p.iam.gserviceaccount.com", privateKey: pem, admin: "admin@example.com" });
    delete process.env.GRAYBOARD_GOOGLE_DIRECTORY_ADMIN;
    expect(loadConfig().googleDirectory).toEqual({ kind: "key", clientEmail: "sa@p.iam.gserviceaccount.com", privateKey: pem });
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY = "{";
    expect(message()).toMatch(/GRAYBOARD_GOOGLE_DIRECTORY_KEY is not JSON/);
    // A key with no Google provider to use it.
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY = key;
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    expect(message()).toBe("GRAYBOARD_GOOGLE_DIRECTORY_KEY is set but GRAYBOARD_IDPS doesn't list google");
    // The key from a file, as every secret can be.
    process.env.GRAYBOARD_IDPS = "okta, google";
    const d = mkdtempSync(join(tmpdir(), "gb-secrets-"));
    try {
      writeFileSync(join(d, "key.json"), `${key}\n`);
      delete process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY;
      process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY_FILE = join(d, "key.json");
      expect(loadConfig().googleDirectory).toMatchObject({ kind: "key", clientEmail: "sa@p.iam.gserviceaccount.com" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT alone is GKE Workload Identity; with a key it's refused (#1565)", () => {
    primary();
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT = "checker@p.iam.gserviceaccount.com";
    expect(loadConfig().googleDirectory).toEqual({ kind: "metadata", serviceAccount: "checker@p.iam.gserviceaccount.com" });
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_ADMIN = "admin@example.com";
    expect(loadConfig().googleDirectory).toEqual({ kind: "metadata", serviceAccount: "checker@p.iam.gserviceaccount.com", admin: "admin@example.com" });
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY = "{}";
    expect(message()).toBe("set one of GRAYBOARD_GOOGLE_DIRECTORY_KEY and GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT, not both");
    delete process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY;
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT = "not an email";
    expect(message()).toMatch(/GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT must be a service account's email/);
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT = "checker@p.iam.gserviceaccount.com";
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    expect(message()).toBe("GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT is set but GRAYBOARD_IDPS doesn't list google");
  });

  test("an external_account GRAYBOARD_GOOGLE_DIRECTORY_KEY is Workload Identity Federation (#1565)", () => {
    primary();
    process.env.GRAYBOARD_GOOGLE_DIRECTORY_KEY = JSON.stringify({
      type: "external_account", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/checker@p.iam.gserviceaccount.com:generateAccessToken",
      credential_source: { file: "/var/run/secrets/token" },
    });
    expect(loadConfig().googleDirectory).toMatchObject({ kind: "federated", serviceAccount: "checker@p.iam.gserviceaccount.com", source: { file: "/var/run/secrets/token" } });
  });

  test("the Keycloak directory pair turns on oidc's directory check against the issuer's realm, or the URL named (#1555)", () => {
    process.env.GRAYBOARD_IDPS = "oidc";
    oidc();
    expect(loadConfig().keycloakDirectory).toBeUndefined();
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID = "grayboard-directory";
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET = "dir-private";
    expect(loadConfig().keycloakDirectory).toEqual({ baseUrl: "https://sso.example.com", realm: "eng", clientId: "grayboard-directory", clientSecret: "dir-private" });
    // In-cluster, plain http: the public hostname keeps /admin off.
    for (const url of ["http://keycloak.auth.svc:8080", "https://kc.internal/auth"]) {
      process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_URL = url;
      expect(loadConfig().keycloakDirectory).toMatchObject({ baseUrl: url, realm: "eng" });
    }
    for (const url of ["keycloak:8080", "ftp://kc", "http://kc/", "http://kc?x", "http://u:p@kc", "http://kc/realms/eng", ""]) {
      process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_URL = url;
      expect(message()).toMatch(/^GRAYBOARD_KEYCLOAK_DIRECTORY_URL must be an http\(s\) URL/);
    }
    delete process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_URL;
    // The secret from a file, as every secret can be.
    const d = mkdtempSync(join(tmpdir(), "gb-secrets-"));
    try {
      writeFileSync(join(d, "secret"), "dir-file-secret\n");
      delete process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET;
      process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET_FILE = join(d, "secret");
      expect(loadConfig().keycloakDirectory?.clientSecret).toBe("dir-file-secret");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("half a Keycloak directory configuration, or one with nothing to check, refuses to start (#1555)", () => {
    process.env.GRAYBOARD_IDPS = "oidc";
    oidc();
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID = "grayboard-directory";
    expect(message()).toBe("GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID set, so GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET is required too");
    delete process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID;
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_URL = "http://kc:8080";
    expect(message()).toMatch(/^GRAYBOARD_KEYCLOAK_DIRECTORY_URL set, so GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID is required too/);
    delete process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_URL;
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID = "grayboard-directory";
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET = "has space";
    expect(message()).toMatch(/must be nonempty credentials without whitespace/);
    expect(message()).not.toContain("has space");
    process.env.GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET = "dir-private";
    // An issuer that isn't a Keycloak realm.
    process.env.GRAYBOARD_OIDC_ISSUER = "https://login.example.com/oauth2/default";
    expect(message()).toMatch(/^GRAYBOARD_OIDC_ISSUER is not a Keycloak realm URL/);
    // No oidc provider to check.
    for (const k of ["GRAYBOARD_OIDC_ISSUER", "GRAYBOARD_OIDC_CLIENT_ID", "GRAYBOARD_OIDC_ALLOWED_DOMAINS"]) delete process.env[k];
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    expect(message()).toMatch(/set but GRAYBOARD_IDPS doesn't list oidc/);
  });

  test("the Okta directory pair turns on okta's directory check against the issuer's org, or the URL named (#1563)", () => {
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const pem = rsa.export({ type: "pkcs8", format: "pem" }) as string;
    expect(loadConfig().oktaDirectory).toBeUndefined();
    process.env.GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID = "0oa1checker";
    process.env.GRAYBOARD_OKTA_DIRECTORY_KEY = JSON.stringify({ ...rsa.export({ format: "jwk" }), kid: "kid-1" });
    expect(loadConfig().oktaDirectory).toEqual({ orgUrl: "https://example.okta.com", clientId: "0oa1checker", privateKey: pem, alg: "RS256", keyId: "kid-1" });
    // A custom authorization server's issuer: the org is its origin.
    process.env.GRAYBOARD_OKTA_ISSUER = "https://example.okta.com/oauth2/default";
    expect(loadConfig().oktaDirectory?.orgUrl).toBe("https://example.okta.com");
    // An issuer on a custom domain names the okta.com domain for the API.
    process.env.GRAYBOARD_OKTA_ISSUER = "https://login.example.com/oauth2/default";
    process.env.GRAYBOARD_OKTA_DIRECTORY_URL = "https://example.okta.com";
    expect(loadConfig().oktaDirectory?.orgUrl).toBe("https://example.okta.com");
    for (const url of ["http://example.okta.com", "https://example.okta.com/", "https://example.okta.com/oauth2/default", "example.okta.com", ""]) {
      process.env.GRAYBOARD_OKTA_DIRECTORY_URL = url;
      expect(message()).toMatch(/^GRAYBOARD_OKTA_DIRECTORY_URL must be the org's https origin/);
    }
    delete process.env.GRAYBOARD_OKTA_DIRECTORY_URL;
    // The key from a file, as every secret can be, with its id named.
    const d = mkdtempSync(join(tmpdir(), "gb-secrets-"));
    try {
      writeFileSync(join(d, "key.pem"), pem);
      delete process.env.GRAYBOARD_OKTA_DIRECTORY_KEY;
      process.env.GRAYBOARD_OKTA_DIRECTORY_KEY_FILE = join(d, "key.pem");
      process.env.GRAYBOARD_OKTA_DIRECTORY_KEY_ID = "kid-2";
      expect(loadConfig().oktaDirectory).toMatchObject({ privateKey: pem, keyId: "kid-2" });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("half an Okta directory configuration, or one with nothing to check, refuses to start (#1563)", () => {
    process.env.GRAYBOARD_IDPS = "okta";
    okta();
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    process.env.GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID = "0oa1checker";
    expect(message()).toBe("GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID set, so GRAYBOARD_OKTA_DIRECTORY_KEY is required too");
    delete process.env.GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID;
    process.env.GRAYBOARD_OKTA_DIRECTORY_KEY_ID = "kid";
    expect(message()).toMatch(/^GRAYBOARD_OKTA_DIRECTORY_KEY_ID set, so GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID is required too/);
    delete process.env.GRAYBOARD_OKTA_DIRECTORY_KEY_ID;
    process.env.GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID = "has space";
    process.env.GRAYBOARD_OKTA_DIRECTORY_KEY = pem;
    expect(message()).toMatch(/^GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID must be a nonempty client id/);
    process.env.GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID = "0oa1checker";
    process.env.GRAYBOARD_OKTA_DIRECTORY_KEY = "-----BEGIN RSA PUBLIC KEY-----";
    expect(message()).toMatch(/^GRAYBOARD_OKTA_DIRECTORY_KEY is not a JSON Web Key or a PEM private key/);
    process.env.GRAYBOARD_OKTA_DIRECTORY_KEY = pem;
    // An issuer that isn't an Okta authorization server.
    process.env.GRAYBOARD_OKTA_ISSUER = "https://example.okta.com/realms/eng";
    expect(message()).toMatch(/^GRAYBOARD_OKTA_ISSUER is not an Okta authorization server URL/);
    // No okta provider to check.
    for (const k of ["GRAYBOARD_OKTA_ISSUER", "GRAYBOARD_OKTA_CLIENT_ID", "GRAYBOARD_OKTA_CLIENT_SECRET", "GRAYBOARD_OKTA_ALLOWED_DOMAINS"]) delete process.env[k];
    process.env.GRAYBOARD_IDPS = "google";
    primary();
    expect(message()).toMatch(/set but GRAYBOARD_IDPS doesn't list okta$/);
  });

  test("the hello limit defaults to 60 and 1/s; set, the burst is a whole number up to 10000 and the rate at least 0.1/s", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_HELLO_BURST = "10";
    process.env.GRAYBOARD_HELLO_PER_SEC = "0.5";
    expect(loadConfig().helloLimit).toEqual({ burst: 10, perSec: 0.5 });
    process.env.GRAYBOARD_HELLO_BURST = "";
    process.env.GRAYBOARD_HELLO_PER_SEC = "";
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    for (const bad of ["0", "1.5", "-3", "ten"]) {
      process.env.GRAYBOARD_HELLO_BURST = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HELLO_BURST must be a positive whole number/);
    }
    process.env.GRAYBOARD_HELLO_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HELLO_BURST can be at most 10000/);
    process.env.GRAYBOARD_HELLO_BURST = "";
    // Below 0.1/s, one token's wait outlasts a client's startup window.
    for (const bad of ["0", "0.0", "0.05", "-1", "1e3", "fast"]) {
      process.env.GRAYBOARD_HELLO_PER_SEC = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HELLO_PER_SEC must be a number of at least 0.1/);
    }
    process.env.GRAYBOARD_HELLO_PER_SEC = "0.1";
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 0.1 });
  });

  test("the per-scope name cap defaults to 500; set, it parses as a positive whole number (#347)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().aliasScopeCap).toBe(500);
    process.env.GRAYBOARD_ALIAS_SCOPE_CAP = "40";
    expect(loadConfig().aliasScopeCap).toBe(40);
    for (const bad of ["0", "2.5", "many"]) {
      process.env.GRAYBOARD_ALIAS_SCOPE_CAP = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_ALIAS_SCOPE_CAP must be a positive whole number of names/);
    }
  });

  test("delegate's per-user limit defaults to 60 and 0.1/s and its open cap to 20; set, they parse like the hello limit (#252)", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().delegateLimit).toEqual({ burst: 60, perSec: 0.1 });
    expect(loadConfig().delegateOpenCap).toBe(20);
    process.env.GRAYBOARD_DELEGATE_BURST = "200";
    process.env.GRAYBOARD_DELEGATE_PER_SEC = "0.5";
    process.env.GRAYBOARD_DELEGATE_OPEN_CAP = "50";
    expect(loadConfig().delegateLimit).toEqual({ burst: 200, perSec: 0.5 });
    expect(loadConfig().delegateOpenCap).toBe(50);
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_DELEGATE_BURST = "";
    process.env.GRAYBOARD_DELEGATE_PER_SEC = "";
    process.env.GRAYBOARD_DELEGATE_OPEN_CAP = "";
    expect(loadConfig().delegateLimit).toEqual({ burst: 60, perSec: 0.1 });
    expect(loadConfig().delegateOpenCap).toBe(20);
    for (const bad of ["0", "1.5", "-3", "ten"]) {
      process.env.GRAYBOARD_DELEGATE_BURST = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_DELEGATE_BURST must be a positive whole number of requests/);
    }
    process.env.GRAYBOARD_DELEGATE_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_DELEGATE_BURST can be at most 10000/);
    process.env.GRAYBOARD_DELEGATE_BURST = "";
    for (const bad of ["0", "0.05", "-1", "1e3", "slow"]) {
      process.env.GRAYBOARD_DELEGATE_PER_SEC = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_DELEGATE_PER_SEC must be a number of at least 0.1/);
    }
    process.env.GRAYBOARD_DELEGATE_PER_SEC = "";
    for (const bad of ["0", " 20", "1e3", "2.5", "-1", "many"]) {
      process.env.GRAYBOARD_DELEGATE_OPEN_CAP = bad;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_DELEGATE_OPEN_CAP must be a positive whole number of requests/);
    }
    process.env.GRAYBOARD_DELEGATE_OPEN_CAP = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_DELEGATE_OPEN_CAP can be at most 10000/);
  });

  test("the auth-failure limit parses like the hello limit, under its own names", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().authFailLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "20";
    process.env.GRAYBOARD_AUTH_FAIL_PER_SEC = "0.25";
    expect(loadConfig().authFailLimit).toEqual({ burst: 20, perSec: 0.25 });
    expect(loadConfig().helloLimit).toEqual({ burst: 60, perSec: 1 });
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "0";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUTH_FAIL_BURST must be a positive whole number of failures/);
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "10001";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUTH_FAIL_BURST can be at most 10000/);
    process.env.GRAYBOARD_AUTH_FAIL_BURST = "";
    process.env.GRAYBOARD_AUTH_FAIL_PER_SEC = "0.01";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUTH_FAIL_PER_SEC must be a number of at least 0.1/);
  });

  test("trusted proxies: unset or empty is loopback, \"none\" is nobody, a list replaces the default and must parse", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().trustedProxies).toEqual(["127.0.0.0/8", "::1/128"]);
    process.env.GRAYBOARD_TRUSTED_PROXIES = " ";
    expect(loadConfig().trustedProxies).toEqual(["127.0.0.0/8", "::1/128"]);
    process.env.GRAYBOARD_TRUSTED_PROXIES = "none";
    expect(loadConfig().trustedProxies).toEqual([]);
    process.env.GRAYBOARD_TRUSTED_PROXIES = "127.0.0.1, 10.0.0.0/8,fd00::/8";
    expect(loadConfig().trustedProxies).toEqual(["127.0.0.1/32", "10.0.0.0/8", "fd00::/8"]);
    for (const bad of ["10.0.0.0/33", "caddy", "127.0.0.1,", "none,10.0.0.1"]) {
      process.env.GRAYBOARD_TRUSTED_PROXIES = bad;
      expect(() => loadConfig()).toThrow(/^GRAYBOARD_TRUSTED_PROXIES: ".*" is not an IP address or CIDR/);
    }
  });

  test("retention days and the port parse strictly: garbage refuses to start, unset and empty mean the defaults", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    // Unset: the server's defaults.
    expect(loadConfig()).toMatchObject({ messageRetentionDays: 90, auditRetentionDays: 90, httpPort: 8080 });
    // Set and valid, including port 0 (an ephemeral port).
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "30";
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "365";
    process.env.GRAYBOARD_HTTP_PORT = "0";
    expect(loadConfig()).toMatchObject({ messageRetentionDays: 30, auditRetentionDays: 365, httpPort: 0 });
    // Empty string is unset, like local mode's BUS_RETENTION_DAYS.
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "";
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "";
    process.env.GRAYBOARD_HTTP_PORT = "";
    expect(loadConfig()).toMatchObject({ messageRetentionDays: 90, auditRetentionDays: 90, httpPort: 8080 });
    // NaN would make every `created_at < cutoff` false and silently prune nothing.
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "abc";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_MESSAGE_RETENTION_DAYS must be a whole number of days, not "abc"/);
    process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS = "30";
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "0";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_AUDIT_RETENTION_DAYS must be a whole number of days, not "0"/);
    process.env.GRAYBOARD_AUDIT_RETENTION_DAYS = "365";
    process.env.GRAYBOARD_HTTP_PORT = "notaport";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HTTP_PORT must be a port between 0 and 65535, not "notaport"/);
    process.env.GRAYBOARD_HTTP_PORT = "70000";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_HTTP_PORT must be a port between 0 and 65535, not "70000"/);
    // Number() would accept these; the digit gate refuses them like local's day rule.
    for (const weird of ["1e3", "0x1F90", " 8080 ", "8080.0", "+8080", "-1"]) {
      process.env.GRAYBOARD_HTTP_PORT = weird;
      expect(() => loadConfig()).toThrow(/GRAYBOARD_HTTP_PORT must be a port between 0 and 65535/);
    }
  });

  test("attachment caps have ceilings, and the per-user quota holds at least one message", () => {
    process.env.GRAYBOARD_DEV_AUTH = "1";
    expect(loadConfig().attachmentUserQuota).toBe(1024 * 1024 * 1024);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = String(100 * 1024 * 1024 + 1);
    process.env.GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES = String(300 * 1024 * 1024);
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_BYTES can be at most 104857600 bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_BYTES = "1000";
    expect(() => loadConfig()).toThrow(/GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES can be at most 262144000 bytes/);
    process.env.GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES = "3000";
    process.env.GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES = "2999";
    expect(() => loadConfig()).toThrow(/USER_QUOTA_BYTES can't be less than GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES/);
    process.env.GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES = "5000";
    expect(loadConfig().attachmentUserQuota).toBe(5000);
  });
});
