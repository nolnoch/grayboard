// #930 A2b: Google's directory check against a scripted token endpoint and users.get, with a key made per run; #1565
// its keyless sources (GKE metadata server, Workload Identity Federation) against a scripted metadata server, STS and IAM Credentials.
import { beforeAll, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { exportPKCS8, generateKeyPair, jwtVerify, type KeyLike } from "jose";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTORY_SCOPE, GOOGLE_TOKEN_URL, googleDirectoryStatus, parseDirectoryCredential } from "./idp_google_directory.ts";

const SA = "checker@proj.iam.gserviceaccount.com";
let pem: string, pub: KeyLike;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  pem = await exportPKCS8(pair.privateKey);
  pub = pair.publicKey;
});
const keyJson = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "service_account", client_email: SA, private_key: pem, ...over });

type Reply = { status: number; body?: unknown };
// A fake Google: the token endpoint and users.get, each answering from a script; every request recorded.
function google(opts: { token?: () => Reply; user?: (subject: string) => Reply } = {}) {
  const seen: { url: string; auth: string | null; assertion: string | null }[] = [];
  let clock = 1_000_000_000_000;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    seen.push({ url, auth: new Headers(init?.headers).get("authorization"), assertion: body?.get("assertion") ?? null });
    const reply = url === "https://token.test"
      ? (opts.token ?? (() => ({ status: 200, body: { access_token: `tok-${seen.length}`, expires_in: 3600, token_type: "Bearer" } })))()
      : (opts.user ?? (() => ({ status: 200, body: { suspended: false, archived: false } })))(decodeURIComponent(new URL(url).pathname.split("/").pop()!));
    return new Response(reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const options = { tokenUrl: "https://token.test", apiBase: "https://api.test", fetch: fetchFn, now: () => clock };
  return { seen, options, advance: (ms: number) => { clock += ms; }, tokens: () => seen.filter(s => s.url === "https://token.test") };
}
const signal = () => new AbortController().signal;
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);

test("an active user is active; the JWT-bearer assertion carries Google's claims and the token is reused", async () => {
  const g = google();
  const status = googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options);
  expect(await status("1234567890", signal())).toBe("active");
  expect(await status("1234567890", signal())).toBe("active");
  expect(g.tokens()).toHaveLength(1);
  const { payload, protectedHeader } = await jwtVerify(g.tokens()[0]!.assertion!, pub, { issuer: SA, audience: GOOGLE_TOKEN_URL, currentDate: new Date(1_000_000_000_000) });
  expect(protectedHeader).toEqual({ alg: "RS256", typ: "JWT" });
  expect(payload.scope).toBe(DIRECTORY_SCOPE);
  expect(payload.sub).toBeUndefined();
  expect(payload.exp! - payload.iat!).toBe(3600);
  const lookups = g.seen.filter(s => s.url.startsWith("https://api.test"));
  expect(lookups.map(s => [s.url, s.auth])).toEqual([
    ["https://api.test/admin/directory/v1/users/1234567890?fields=suspended,archived", "Bearer tok-1"],
    ["https://api.test/admin/directory/v1/users/1234567890?fields=suspended,archived", "Bearer tok-1"],
  ]);
});

test("under domain-wide delegation the assertion's sub is the admin it impersonates", async () => {
  const g = google();
  await googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, "admin@example.com"), g.options)("1", signal());
  expect((await jwtVerify(g.tokens()[0]!.assertion!, pub, { currentDate: new Date(1_000_000_000_000) })).payload.sub).toBe("admin@example.com");
});

test("suspended and archived are inactive", async () => {
  for (const reply of [{ status: 200, body: { suspended: true, archived: false } }, { status: 200, body: { suspended: false, archived: true } }]) {
    const g = google({ user: () => reply });
    expect(await googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options)("1", signal())).toBe("inactive");
  }
});

// #1600: Google doesn't document users.get's 404 as "no such user", so it is a failed check (transient), never a
// disable, and it keeps the cached token (the token isn't what Google refused). #1601 makes it definite once confirmed.
test("a users.get 404 throws google_user_not_found and keeps the token", async () => {
  for (const reply of [{ status: 404, body: { error: { code: 404, message: "Resource Not Found: userKey" } } }, { status: 404 }, { status: 404, body: "<html>Not Found</html>" }]) {
    const g = google({ user: () => reply });
    const status = googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options);
    expect((await failure(status("1", signal()))).name).toBe("google_user_not_found");
    expect((await failure(status("2", signal()))).name).toBe("google_user_not_found");
    expect(g.tokens()).toHaveLength(1);
  }
});

test("every other answer throws, named for what an operator fixes", async () => {
  const cases: [Parameters<typeof google>[0], string][] = [
    [{ token: () => ({ status: 400, body: { error: "unauthorized_client" } }) }, "google_token_refused"],
    [{ token: () => ({ status: 503 }) }, "google_directory_error"],
    [{ token: () => ({ status: 200, body: { access_token: "t" } }) }, "google_directory_error"],
    [{ user: () => ({ status: 403 }) }, "google_directory_refused"],
    [{ user: () => ({ status: 429 }) }, "google_directory_error"],
    [{ user: () => ({ status: 500 }) }, "google_directory_error"],
    [{ user: () => ({ status: 200, body: {} }) }, "google_directory_error"],
    [{ user: () => ({ status: 200, body: { suspended: "no" } }) }, "google_directory_error"],
    [{ user: () => ({ status: 200, body: "not json" }) }, "google_directory_error"],
    [{ user: () => ({ status: 200, body: null }) }, "google_directory_error"],
    [{ token: () => ({ status: 200, body: "<html>" }) }, "google_directory_error"],
    [{ token: () => ({ status: 200, body: null }) }, "google_directory_error"],
  ];
  for (const [script, name] of cases) {
    const g = google(script);
    expect((await failure(googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options)("1", signal()))).name).toBe(name);
  }
});

test("a token is minted again near its expiry and after a 401; concurrent first calls share one mint", async () => {
  let refuse = false;
  const g = google({ user: () => refuse ? { status: 401 } : { status: 200, body: { suspended: false } } });
  const status = googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options);
  await Promise.all([status("1", signal()), status("2", signal()), status("3", signal())]);
  expect(g.tokens()).toHaveLength(1);
  g.advance(3600_000 - 60_000);
  await status("1", signal());
  expect(g.tokens()).toHaveLength(2);
  refuse = true;
  await failure(status("1", signal()));
  refuse = false;
  await status("1", signal());
  expect(g.tokens()).toHaveLength(3);
});

test("a subject that isn't a Google user id throws without a request", async () => {
  const g = google();
  const status = googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options);
  for (const subject of ["..", ".", "../x?y", "", "12a"]) expect((await failure(status(subject, signal()))).name).toBe("google_directory_error");
  expect(g.seen).toEqual([]);
});

test("a caller's abort stops its own wait, not the shared token request; users.get gets the caller's signal", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const signals: (AbortSignal | undefined)[] = [];
  const g = google();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    if (String(input) === "https://token.test") await gate;
    return g.options.fetch(input, init);
  }) as typeof fetch;
  const status = googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), { ...g.options, fetch: fetchFn });
  const quitter = new AbortController(), stayer = new AbortController();
  const first = failure(status("1", quitter.signal));
  const second = status("2", stayer.signal);
  quitter.abort(new Error("timeout"));
  expect((await first).message).toBe("timeout");
  release();
  expect(await second).toBe("active");
  expect(g.tokens()).toHaveLength(1);
  expect(signals[0]).not.toBe(quitter.signal);
  expect(signals.at(-1)).toBe(stayer.signal);
});

test("a refused credential logs Google's error text once per window; the class goes to the audit", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warned.push(m); };
  try {
    const g = google({ token: () => ({ status: 400, body: { error: "unauthorized_client" } }) });
    const status = googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), g.options);
    expect((await failure(status("1", signal()))).name).toBe("google_token_refused");
    await failure(status("1", signal()));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("unauthorized_client");
    g.advance(10 * 60_000);
    await failure(status("1", signal()));
    expect(warned).toHaveLength(2);
    const d = google({ user: () => ({ status: 403, body: { error: { message: "Not Authorized to access this resource/api" } } }) });
    expect((await failure(googleDirectoryStatus(parseDirectoryCredential(keyJson(), undefined, undefined), d.options)("1", signal()))).name).toBe("google_directory_refused");
    expect(warned.at(-1)).toContain("Not Authorized");
  } finally { console.warn = warn; }
});

test("a key that isn't a service account's RSA key, or an admin that isn't an email, is refused at startup", async () => {
  const pkcs1 = createPrivateKey(pem).export({ type: "pkcs1", format: "pem" }) as string;
  const ec = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
  for (const [raw, admin, msg] of [
    ["{", undefined, /is not JSON/],
    [keyJson({ type: "authorized_user" }), undefined, /must be a service account key/],
    [keyJson({ client_email: undefined }), undefined, /has no client_email/],
    [keyJson({ private_key: undefined }), undefined, /has no private_key/],
    [keyJson({ private_key: "garbage" }), undefined, /not a PKCS#8 RSA private key/],
    [keyJson({ private_key: ec }), undefined, /not a PKCS#8 RSA private key/],
    [keyJson({ private_key: pkcs1 }), undefined, /not a PKCS#8 RSA private key/],
    [keyJson({ private_key: `\n${pem}` }), undefined, /not a PKCS#8 RSA private key/],
    [keyJson(), "admin", /must be an admin's email/],
    [keyJson(), "", /must be an admin's email/],
  ] as const) expect(() => parseDirectoryCredential(raw, undefined, admin)).toThrow(msg);
  // The refusal never echoes the key.
  try { parseDirectoryCredential(keyJson({ private_key: "SECRETSECRET" }), undefined, undefined); } catch (e) { expect((e as Error).message).not.toContain("SECRET"); }
});

// #1565: keyless. A fake Google with the metadata server, STS, IAM Credentials, the token endpoint and users.get.

type Req = { url: string; method: string; headers: Headers; form: URLSearchParams | null; json: Record<string, unknown> | null };
function keyless(script: Partial<Record<"metadata" | "sts" | "subject" | "generate" | "sign" | "bearer" | "user", (r: Req) => Reply>> = {}) {
  const seen: Req[] = [];
  let clock = 1_000_000_000_000;
  const route = (url: string) => url.startsWith("http://meta.test") ? "metadata" : url.startsWith("https://sts.googleapis.com") ? "sts"
    : url.startsWith("http://subject.test") ? "subject" : url.endsWith(":generateAccessToken") ? "generate" : url.endsWith(":signJwt") ? "sign"
    : url === "https://token.test" ? "bearer" : "user";
  const defaults: Record<string, (r: Req) => Reply> = {
    metadata: () => ({ status: 200, body: { access_token: "meta-tok", expires_in: 3599, token_type: "Bearer" } }),
    sts: () => ({ status: 200, body: { access_token: "sts-tok", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 } }),
    subject: () => ({ status: 200, body: { id_token: "url-subject" } }),
    generate: () => ({ status: 200, body: { accessToken: "sa-tok", expireTime: new Date(clock + 3600_000).toISOString() } }),
    sign: r => ({ status: 200, body: { keyId: "k1", signedJwt: `signed:${(r.json as { payload: string }).payload}` } }),
    bearer: () => ({ status: 200, body: { access_token: "dwd-tok", expires_in: 3600, token_type: "Bearer" } }),
    user: () => ({ status: 200, body: { suspended: false } }),
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = init?.body instanceof URLSearchParams ? init.body : null;
    const json = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    const req = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), form, json };
    seen.push(req);
    const kind = route(url);
    const reply = (script[kind as keyof typeof script] ?? defaults[kind]!)(req);
    return new Response(reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const options = { tokenUrl: "https://token.test", apiBase: "https://api.test", metadataUrl: "http://meta.test/token", iamBase: "https://iam.test", fetch: fetchFn, now: () => clock };
  return { seen, options, advance: (ms: number) => { clock += ms; }, of: (kind: string) => seen.filter(r => route(r.url) === kind) };
}

const AUDIENCE = "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/eks";
const external = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "external_account", audience: AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token",
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
  credential_source: { file: "/var/run/secrets/token" }, ...over,
});

test("GKE: the metadata server's token buys a directory-scoped token for the named service account", async () => {
  const g = keyless();
  const status = googleDirectoryStatus(parseDirectoryCredential(undefined, SA, undefined), g.options);
  expect(await status("1", signal())).toBe("active");
  expect(await status("2", signal())).toBe("active");
  const [meta] = g.of("metadata");
  expect(g.of("metadata")).toHaveLength(1);
  expect([meta!.url, meta!.method, meta!.headers.get("metadata-flavor")]).toEqual(["http://meta.test/token", "GET", "Google"]);
  const [gen] = g.of("generate");
  expect(gen!.url).toBe(`https://iam.test/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:generateAccessToken`);
  expect([gen!.method, gen!.headers.get("authorization"), gen!.headers.get("content-type")]).toEqual(["POST", "Bearer meta-tok", "application/json"]);
  expect(gen!.json).toEqual({ scope: [DIRECTORY_SCOPE], lifetime: "3600s" });
  expect(g.of("user").map(r => r.headers.get("authorization"))).toEqual(["Bearer sa-tok", "Bearer sa-tok"]);
  // The lifetime comes from expireTime: minted again a minute before it.
  g.advance(3600_000 - 60_000);
  await status("1", signal());
  expect(g.of("generate")).toHaveLength(2);
});

test("GKE under delegation: signJwt signs the assertion with sub, then the JWT-bearer exchange", async () => {
  const g = keyless();
  await googleDirectoryStatus(parseDirectoryCredential(undefined, SA, "admin@example.com"), g.options)("1", signal());
  const [sign] = g.of("sign");
  expect(sign!.headers.get("authorization")).toBe("Bearer meta-tok");
  const claims = JSON.parse((sign!.json as { payload: string }).payload);
  expect(claims).toEqual({ iss: SA, sub: "admin@example.com", scope: DIRECTORY_SCOPE, aud: GOOGLE_TOKEN_URL, iat: 1_000_000_000, exp: 1_000_003_600 });
  const [bearer] = g.of("bearer");
  expect(bearer!.form?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  expect(bearer!.form?.get("assertion")).toBe(`signed:${(sign!.json as { payload: string }).payload}`);
  expect(g.of("generate")).toEqual([]);
  expect(g.of("user")[0]!.headers.get("authorization")).toBe("Bearer dwd-tok");
});

test("federation: the subject token, read fresh each mint, is exchanged at STS, then the service account is impersonated", async () => {
  const d = mkdtempSync(join(tmpdir(), "gb-wif-"));
  try {
    const file = join(d, "token");
    writeFileSync(file, "oidc-1\n");
    const g = keyless();
    const status = googleDirectoryStatus(parseDirectoryCredential(external({ credential_source: { file } }), undefined, undefined), g.options);
    await status("1", signal());
    const [sts] = g.of("sts");
    expect(sts!.url).toBe("https://sts.googleapis.com/v1/token");
    expect(sts!.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(sts!.form!)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience: AUDIENCE, scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: "oidc-1", subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    });
    expect(g.of("generate")[0]!.headers.get("authorization")).toBe("Bearer sts-tok");
    writeFileSync(file, "oidc-2");
    g.advance(3600_000);
    await status("1", signal());
    expect(g.of("sts")[1]!.form!.get("subject_token")).toBe("oidc-2");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("federation from a URL source sends its headers and reads a JSON field", async () => {
  const g = keyless();
  const cred = external({ credential_source: { url: "http://subject.test/token?x=1", headers: { Metadata: "True" }, format: { type: "json", subject_token_field_name: "id_token" } } });
  await googleDirectoryStatus(parseDirectoryCredential(cred, undefined, undefined), g.options)("1", signal());
  expect(g.of("subject")[0]!.headers.get("metadata")).toBe("True");
  expect(g.of("sts")[0]!.form!.get("subject_token")).toBe("url-subject");
});

test("keyless refusals are classed for what an operator fixes", async () => {
  const cases: [Parameters<typeof keyless>[0], string | undefined, string][] = [
    [{ metadata: () => ({ status: 404 }) }, undefined, "google_token_refused"],
    [{ metadata: () => ({ status: 500 }) }, undefined, "google_directory_error"],
    [{ metadata: () => ({ status: 200, body: {} }) }, undefined, "google_directory_error"],
    [{ generate: () => ({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } }) }, undefined, "google_token_refused"],
    [{ generate: () => ({ status: 404 }) }, undefined, "google_token_refused"],
    [{ generate: () => ({ status: 200, body: { accessToken: "t", expireTime: "soon" } }) }, undefined, "google_directory_error"],
    [{ sign: () => ({ status: 403 }) }, "admin@example.com", "google_token_refused"],
    [{ sign: () => ({ status: 200, body: { keyId: "k" } }) }, "admin@example.com", "google_directory_error"],
    [{ bearer: () => ({ status: 400, body: { error: "unauthorized_client" } }) }, "admin@example.com", "google_token_refused"],
  ];
  for (const [script, admin, name] of cases) {
    const g = keyless(script);
    expect((await failure(googleDirectoryStatus(parseDirectoryCredential(undefined, SA, admin), g.options)("1", signal()))).name).toBe(name);
  }
  for (const [script, src, name] of [
    [{ sts: () => ({ status: 400, body: { error: "invalid_grant" } }) }, { url: "http://subject.test/t" }, "google_token_refused"],
    [{ sts: () => ({ status: 503 }) }, { url: "http://subject.test/t" }, "google_directory_error"],
    [{ subject: () => ({ status: 403 }) }, { url: "http://subject.test/t" }, "google_token_refused"],
    [{ subject: () => ({ status: 200, body: "" }) }, { url: "http://subject.test/t" }, "google_token_refused"],
    [{ subject: () => ({ status: 503 }) }, { url: "http://subject.test/t" }, "google_directory_error"],
    [{}, { file: "/nonexistent/gb-wif-token" }, "google_token_refused"],
  ] as const) {
    const g = keyless(script);
    expect((await failure(googleDirectoryStatus(parseDirectoryCredential(external({ credential_source: src }), undefined, undefined), g.options)("1", signal()))).name).toBe(name);
  }
});

test("an external_account configuration that couldn't work is refused at startup", () => {
  for (const [over, msg] of [
    [{ audience: "//iam.googleapis.com/locations/global/workforcePools/p/providers/x" }, /audience must be a workload identity pool provider/],
    [{ subject_token_type: "urn:ietf:params:aws:token-type:aws4_request" }, /subject_token_type must be/],
    [{ token_url: "https://evil.example.com/v1/token" }, /token_url must be Google's STS endpoint/],
    [{ token_url: "http://sts.googleapis.com/v1/token" }, /token_url must be Google's STS endpoint/],
    [{ token_url: 7 }, /token_url is not a URL/],
    [{ service_account_impersonation_url: undefined }, /service_account_impersonation_url must name the service account/],
    [{ service_account_impersonation_url: `https://evil.example.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken` }, /service_account_impersonation_url must name/],
    [{ service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a%E0%A4%A:generateAccessToken" }, /not valid percent-encoding/],
    [{ credential_source: undefined }, /credential_source is missing/],
    [{ credential_source: { environment_id: "aws1", regional_cred_verification_url: "x" } }, /AWS credential_source isn't supported/],
    [{ credential_source: { executable: { command: "/bin/x" } } }, /only a file or url credential_source/],
    [{ credential_source: {} }, /needs a file or a url/],
    [{ credential_source: { url: "ftp://x/y" } }, /must be http or https/],
    [{ credential_source: { url: "http://x/y", headers: [{ key: "a", value: "b" }] } }, /headers must map names to strings/],
    [{ credential_source: { file: "/f", format: { type: "xml" } } }, /format.type must be text or json/],
    [{ credential_source: { file: "/f", format: { type: "json" } } }, /subject_token_field_name is required/],
  ] as const) expect(() => parseDirectoryCredential(external(over), undefined, undefined)).toThrow(msg);
  expect(parseDirectoryCredential(external(), undefined, "admin@example.com")).toEqual({
    kind: "federated", serviceAccount: SA, audience: AUDIENCE, subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    tokenUrl: "https://sts.googleapis.com/v1/token", source: { file: "/var/run/secrets/token" }, admin: "admin@example.com",
  });
  expect(() => parseDirectoryCredential(undefined, undefined, undefined)).toThrow(/set GRAYBOARD_GOOGLE_DIRECTORY_KEY or/);
});
