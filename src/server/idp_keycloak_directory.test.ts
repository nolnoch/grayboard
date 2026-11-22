// #1555: Keycloak's directory check against a scripted token endpoint and admin REST API.
import { expect, test } from "bun:test";
import { keycloakDirectoryStatus, keycloakRealm } from "./idp_keycloak_directory.ts";

const BASE = "http://keycloak.internal:8080";
const TOKEN_URL = `${BASE}/realms/acme/protocol/openid-connect/token`;
const USERS = `${BASE}/admin/realms/acme/users/`;
const LOCKS = `${BASE}/admin/realms/acme/attack-detection/brute-force/users/`;
const config = { baseUrl: BASE, realm: "acme", clientId: "grayboard-directory", clientSecret: "s3cr=t:x" };
const ID = "6f1c2c1e-6a4e-4b8e-9a4e-1c2c1e6a4e4b";

type Reply = { status: number; body?: unknown };
// A fake Keycloak: the token endpoint, users/{id} and the brute-force status, each answering from a script; every
// request recorded.
function keycloak(opts: { token?: () => Reply; user?: (id: string) => Reply; lock?: (id: string) => Reply } = {}) {
  const seen: { url: string; method: string; auth: string | null; accept: string | null; body: string | null; redirect?: RequestRedirect }[] = [];
  let clock = 1_000_000_000_000;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), accept: headers.get("accept"), body: init?.body ? String(init.body) : null, redirect: init?.redirect });
    const id = () => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const reply = url === TOKEN_URL
      ? (opts.token ?? (() => ({ status: 200, body: { access_token: `tok-${seen.length}`, expires_in: 300, token_type: "Bearer" } })))()
      : url.startsWith(USERS) ? (opts.user ?? (i => ({ status: 200, body: { id: i, username: "ann", enabled: true } })))(id())
      : url.startsWith(LOCKS) ? (opts.lock ?? (() => ({ status: 200, body: { disabled: false, numFailures: 0 } })))(id())
      : { status: 599 };
    return new Response(reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { seen, options: { fetch: fetchFn, now: () => clock }, advance: (ms: number) => { clock += ms; }, tokens: () => seen.filter(s => s.url === TOKEN_URL) };
}
const signal = () => new AbortController().signal;
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);
const notFound = { status: 404, body: { error: "User not found" } };
const disabled = (i: string) => ({ status: 200, body: { id: i, enabled: false } });

test("an enabled user is active; client credentials by basic auth, no scope, the token reused; no redirects", async () => {
  const k = keycloak();
  const status = keycloakDirectoryStatus(config, k.options);
  expect(await status(ID, signal())).toBe("active");
  expect(await status(ID, signal())).toBe("active");
  const [mint] = k.tokens();
  expect(k.tokens()).toHaveLength(1);
  expect(mint!.method).toBe("POST");
  expect(mint!.body).toBe("grant_type=client_credentials");
  // RFC 6749 §2.3.1: each half form-encoded before base64.
  expect(mint!.auth).toBe(`Basic ${Buffer.from("grayboard-directory:s3cr%3Dt%3Ax").toString("base64")}`);
  expect(k.seen.slice(1).map(s => [s.url, s.auth, s.accept])).toEqual([
    [`${USERS}${ID}`, "Bearer tok-1", "application/json"],
    [`${USERS}${ID}`, "Bearer tok-1", "application/json"],
  ]);
  expect(k.seen.every(s => s.redirect === "error")).toBe(true);
});

test("Keycloak's 404 \"User not found\" is inactive; any other 404 throws", async () => {
  expect(await keycloakDirectoryStatus(config, keycloak({ user: () => notFound }).options)(ID, signal())).toBe("inactive");
  for (const reply of [{ status: 404 }, { status: 404, body: "<html>Not Found</html>" }, { status: 404, body: { error: "RESTEASY003210: Could not find resource" } }])
    expect((await failure(keycloakDirectoryStatus(config, keycloak({ user: () => reply }).options)(ID, signal()))).name).toBe("keycloak_directory_error");
});

test("a disabled user is inactive unless brute-force detection locked it", async () => {
  const k = keycloak({ user: disabled });
  expect(await keycloakDirectoryStatus(config, k.options)(ID, signal())).toBe("inactive");
  expect(k.seen.at(-1)!.url).toBe(`${LOCKS}${ID}`);
  const locked = keycloak({ user: disabled, lock: () => ({ status: 200, body: { disabled: true, numFailures: 30 } }) });
  expect((await failure(keycloakDirectoryStatus(config, locked.options)(ID, signal()))).name).toBe("keycloak_locked_out");
  // A federated user reads disabled when its provider is off: never inactive, and no brute-force call.
  const ldap = keycloak({ user: i => ({ status: 200, body: { id: i, enabled: false, federationLink: "ldap-component-id" } }) });
  expect((await failure(keycloakDirectoryStatus(config, ldap.options)(ID, signal()))).name).toBe("keycloak_federated_disabled");
  expect(ldap.seen.some(s => s.url.startsWith(LOCKS))).toBe(false);
  // An enabled federated user is active.
  expect(await keycloakDirectoryStatus(config, keycloak({ user: i => ({ status: 200, body: { id: i, enabled: true, federationLink: "x" } }) }).options)(ID, signal())).toBe("active");
  // An enabled user never costs the second call.
  const active = keycloak();
  await keycloakDirectoryStatus(config, active.options)(ID, signal());
  expect(active.seen.some(s => s.url.startsWith(LOCKS))).toBe(false);
});

test("every other answer throws, named for what an operator fixes", async () => {
  const cases: [Parameters<typeof keycloak>[0], string][] = [
    [{ token: () => ({ status: 401, body: { error: "invalid_client", error_description: "Invalid client or Invalid client credentials" } }) }, "keycloak_token_refused"],
    [{ token: () => ({ status: 400, body: { error: "unauthorized_client" } }) }, "keycloak_token_refused"],
    [{ token: () => ({ status: 503 }) }, "keycloak_directory_error"],
    [{ token: () => ({ status: 200, body: { access_token: "t" } }) }, "keycloak_directory_error"],
    [{ token: () => ({ status: 200, body: "<html>" }) }, "keycloak_directory_error"],
    [{ token: () => ({ status: 200, body: null }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 401 }) }, "keycloak_directory_refused"],
    [{ user: () => ({ status: 403, body: { error: "HTTP 403 Forbidden" } }) }, "keycloak_directory_refused"],
    [{ user: () => ({ status: 429 }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 500 }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 200, body: { id: ID } }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 200, body: { id: ID, enabled: "no" } }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 200, body: { id: "someone-else", enabled: false } }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 200, body: [{ id: ID, enabled: false }] }) }, "keycloak_directory_error"],
    [{ user: () => ({ status: 200, body: "not json" }) }, "keycloak_directory_error"],
    [{ user: disabled, lock: () => ({ status: 403 }) }, "keycloak_directory_refused"],
    [{ user: disabled, lock: () => ({ status: 500 }) }, "keycloak_directory_error"],
    [{ user: disabled, lock: () => ({ status: 200, body: {} }) }, "keycloak_directory_error"],
  ];
  for (const [script, name] of cases)
    expect((await failure(keycloakDirectoryStatus(config, keycloak(script).options)(ID, signal()))).name).toBe(name);
});

test("a network failure or refused redirect is keycloak_directory_error; the caller's abort stays itself", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const e = await failure(keycloakDirectoryStatus(config, { fetch: down })(ID, signal()));
  expect([e.name, (e.cause as Error).message]).toEqual(["keycloak_directory_error", "fetch failed"]);
  // fetch rejects with the signal's reason once the caller aborts mid-request.
  const caller = new AbortController();
  const k = keycloak();
  const midRequest = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === TOKEN_URL) return k.options.fetch(input, init);
    caller.abort(new Error("timeout"));
    throw init!.signal!.reason;
  }) as typeof fetch;
  const pending = failure(keycloakDirectoryStatus(config, { now: k.options.now, fetch: midRequest })(ID, caller.signal));
  expect((await pending).message).toBe("timeout");
});

test("a body over the cap throws rather than buffering it", async () => {
  const k = keycloak({ user: () => ({ status: 200, body: "x".repeat(256 * 1024 + 1) }) });
  expect((await failure(keycloakDirectoryStatus(config, k.options)(ID, signal()))).name).toBe("keycloak_directory_error");
});

test("a token is minted again near its expiry and after a 401; concurrent first calls share one mint", async () => {
  let refuse = false;
  const k = keycloak({ user: i => refuse ? { status: 401 } : { status: 200, body: { id: i, enabled: true } } });
  const status = keycloakDirectoryStatus(config, k.options);
  await Promise.all([status("a", signal()), status("b", signal()), status("c", signal())]);
  expect(k.tokens()).toHaveLength(1);
  k.advance(300_000 - 60_000);
  await status("a", signal());
  expect(k.tokens()).toHaveLength(2);
  refuse = true;
  await failure(status("a", signal()));
  refuse = false;
  await status("a", signal());
  expect(k.tokens()).toHaveLength(3);
  // A 403 is the role, not the token: it keeps the token.
  const f = keycloak({ user: () => ({ status: 403 }) });
  const forbidden = keycloakDirectoryStatus(config, f.options);
  await failure(forbidden("a", signal()));
  await failure(forbidden("a", signal()));
  expect(f.tokens()).toHaveLength(1);
});

test("a subject is encoded into one path segment; one that can't be a user id throws without a request", async () => {
  const k = keycloak();
  const status = keycloakDirectoryStatus(config, k.options);
  // A federated user without import: f:<provider id>:<external id>.
  expect(await status("f:ldap-1:ann/x?y", signal())).toBe("active");
  expect(k.seen.at(-1)!.url).toBe(`${USERS}f%3Aldap-1%3Aann%2Fx%3Fy`);
  const before = k.seen.length;
  for (const subject of ["", ".", "..", "x".repeat(256)]) expect((await failure(status(subject, signal()))).name).toBe("keycloak_directory_error");
  expect(k.seen).toHaveLength(before);
});

test("the realm is encoded into the token and admin paths", async () => {
  const k = keycloak();
  await failure(keycloakDirectoryStatus({ ...config, realm: "a b" }, k.options)(ID, signal()));
  expect(k.seen[0]!.url).toBe(`${BASE}/realms/a%20b/protocol/openid-connect/token`);
});

test("the caller's signal reaches the admin requests", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const k = keycloak({ user: disabled });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => { signals.push(init?.signal); return k.options.fetch(input, init); }) as typeof fetch;
  const caller = new AbortController();
  await keycloakDirectoryStatus(config, { ...k.options, fetch: fetchFn })(ID, caller.signal);
  expect(signals.slice(1)).toEqual([caller.signal, caller.signal]);
  expect(signals[0]).not.toBe(caller.signal);
});

test("a refused credential logs Keycloak's error text once per window; the class goes to the audit", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warned.push(m); };
  try {
    const k = keycloak({ token: () => ({ status: 401, body: { error: "invalid_client", error_description: "Invalid client or Invalid client credentials" } }) });
    const status = keycloakDirectoryStatus(config, k.options);
    expect((await failure(status(ID, signal()))).name).toBe("keycloak_token_refused");
    await failure(status(ID, signal()));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("invalid_client: Invalid client");
    expect(warned[0]).not.toContain(config.clientSecret);
    k.advance(10 * 60_000);
    await failure(status(ID, signal()));
    expect(warned).toHaveLength(2);
    const d = keycloak({ user: () => ({ status: 403, body: { error: "HTTP 403 Forbidden" } }) });
    expect((await failure(keycloakDirectoryStatus(config, d.options)(ID, signal()))).name).toBe("keycloak_directory_refused");
    expect(warned.at(-1)).toContain("HTTP 403 Forbidden");
  } finally { console.warn = warn; }
});

test("keycloakRealm splits a realm issuer into its base and realm", () => {
  expect(keycloakRealm("https://sso.example.com/realms/acme")).toEqual({ baseUrl: "https://sso.example.com", realm: "acme" });
  expect(keycloakRealm("https://sso.example.com/auth/realms/acme")).toEqual({ baseUrl: "https://sso.example.com/auth", realm: "acme" });
  expect(keycloakRealm("https://sso.example.com:8443/realms/a%20b")).toEqual({ baseUrl: "https://sso.example.com:8443", realm: "a b" });
  for (const issuer of ["https://sso.example.com", "https://sso.example.com/realms/", "https://sso.example.com/realms/acme/x", "https://login.okta.example.com/oauth2/default", "https://sso.example.com/realms/acme?x=1", "https://sso.example.com/realms/a%zz"])
    expect(keycloakRealm(issuer)).toBeNull();
});
