// #1563: Okta's directory check against a scripted org authorization server and Users API, which verifies the
// private_key_jwt assertion and every DPoP proof the way Okta documents them, with a key made per run.
import { beforeAll, expect, test } from "bun:test";
import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, exportJWK, exportPKCS8, generateKeyPair, importJWK, jwtVerify, type JWK, type KeyLike } from "jose";
import { OKTA_USERS_SCOPE, oktaDirectoryStatus, oktaOrgUrl, parseOktaDirectoryKey, type OktaDirectoryConfig } from "./idp_okta_directory.ts";

const ORG = "https://example.okta.test";
const TOKEN_URL = `${ORG}/oauth2/v1/token`;
const USERS = `${ORG}/api/v1/users/`;
const CLIENT = "0oa1checker";
const ID = "00u1a2b3c4d5e6f7g8h9";
let config: OktaDirectoryConfig, pub: KeyLike;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  pub = pair.publicKey;
  config = { orgUrl: ORG, clientId: CLIENT, ...parseOktaDirectoryKey(await exportPKCS8(pair.privateKey), "kid-1") };
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Seen = { url: string; method: string; auth: string | null; dpop: string | null; form: URLSearchParams | null; redirect?: RequestRedirect };
// A fake Okta. The token endpoint checks the assertion (iss = sub = client id, aud = the token URL, exp within the
// hour, a jti) and, unless `dpop` is "off", demands a DPoP proof carrying its current nonce (400 use_dpop_nonce with
// one otherwise), answering a DPoP-bound token; the Users API checks the proof's ath against that token.
function okta(opts: { dpop?: "on" | "off"; token?: () => Reply; user?: (id: string) => Reply } = {}) {
  const seen: Seen[] = [];
  let clock = 1_000_000_000_000;
  let nonce = "nonce-1";
  const problems: string[] = [];
  const verifyProof = async (proof: string | null, htm: string, htu: string, extra: Record<string, unknown>) => {
    if (!proof) { problems.push("no proof"); return false; }
    const header = decodeProtectedHeader(proof);
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || "d" in header.jwk) { problems.push("bad proof header"); return false; }
    const { payload } = await jwtVerify(proof, await importJWK(header.jwk as JWK, "ES256"), { currentDate: new Date(clock) });
    if (payload.htm !== htm || payload.htu !== htu || typeof payload.jti !== "string" || typeof payload.iat !== "number") { problems.push("bad proof claims"); return false; }
    for (const [k, v] of Object.entries(extra)) if (payload[k] !== v) { problems.push(`proof ${k} ${String(payload[k])}`); return false; }
    return true;
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const form = init?.body instanceof URLSearchParams ? init.body : null;
    seen.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), dpop: headers.get("dpop"), form, redirect: init?.redirect });
    let reply: Reply;
    if (url === TOKEN_URL) {
      const { payload } = await jwtVerify(form!.get("client_assertion")!, pub, { issuer: CLIENT, subject: CLIENT, audience: TOKEN_URL, currentDate: new Date(clock) });
      if (decodeProtectedHeader(form!.get("client_assertion")!).kid !== config.keyId || typeof payload.jti !== "string" || payload.exp! - Math.floor(clock / 1000) > 3600) problems.push("bad assertion");
      if (form!.get("grant_type") !== "client_credentials" || form!.get("scope") !== OKTA_USERS_SCOPE || form!.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") problems.push("bad form");
      if (opts.token) reply = opts.token();
      else if (opts.dpop === "off") reply = { status: 200, body: { access_token: `tok-${seen.length}`, expires_in: 3600, token_type: "Bearer", scope: OKTA_USERS_SCOPE } };
      else if (!(await verifyProof(headers.get("dpop"), "POST", TOKEN_URL, {}))) reply = { status: 400, body: { error: "invalid_dpop_proof", error_description: "The DPoP proof JWT header is missing." } };
      else if (decodeProtectedHeader(headers.get("dpop")!) && (await jwtVerify(headers.get("dpop")!, await importJWK(decodeProtectedHeader(headers.get("dpop")!).jwk as JWK, "ES256"), { currentDate: new Date(clock) })).payload.nonce !== nonce)
        reply = { status: 400, body: { error: "use_dpop_nonce", error_description: "Authorization server requires nonce in DPoP proof." }, headers: { "DPoP-Nonce": nonce } };
      else reply = { status: 200, body: { access_token: `tok-${seen.length}`, expires_in: 3600, token_type: "DPoP", scope: OKTA_USERS_SCOPE } };
    } else if (url.startsWith(USERS)) {
      const auth = headers.get("authorization") ?? "";
      if (auth.startsWith("DPoP ")) {
        const token = auth.slice(5);
        await verifyProof(headers.get("dpop"), "GET", url, { ath: createHash("sha256").update(token).digest("base64url") });
      } else if (headers.get("dpop")) problems.push("proof on a bearer call");
      reply = (opts.user ?? (i => ({ status: 200, body: { id: i, status: "ACTIVE", profile: { login: "ann@example.com" } } })))(url.slice(USERS.length));
    } else reply = { status: 599 };
    return new Response(reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return {
    seen, problems, options: { fetch: fetchFn, now: () => clock },
    advance: (ms: number) => { clock += ms; }, rotateNonce: (n: string) => { nonce = n; },
    tokens: () => seen.filter(s => s.url === TOKEN_URL),
  };
}
const signal = () => new AbortController().signal;
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);
const user = (status: string) => (i: string) => ({ status: 200, body: { id: i, status } });

test("an active user is active: the nonce retry, a DPoP-bound token reused, each call with a fresh proof; no redirects", async () => {
  const o = okta();
  const status = oktaDirectoryStatus(config, o.options);
  expect(await status(ID, signal())).toBe("active");
  expect(await status(ID, signal())).toBe("active");
  // The first mint learns the nonce, the retry spends it.
  expect(o.tokens()).toHaveLength(2);
  const calls = o.seen.filter(s => s.url.startsWith(USERS));
  expect(calls.map(s => [s.url, s.auth])).toEqual([[`${USERS}${ID}`, "DPoP tok-2"], [`${USERS}${ID}`, "DPoP tok-2"]]);
  // Single-use jtis: the retry re-signs the assertion and the proof, and each API call has its own proof.
  const [first, retry] = o.tokens();
  expect(first!.form!.get("client_assertion")).not.toBe(retry!.form!.get("client_assertion"));
  expect(calls[0]!.dpop).not.toBe(calls[1]!.dpop);
  expect(o.seen.every(s => s.redirect === "error")).toBe(true);
  expect(o.problems).toEqual([]);
  // The nonce is kept: a later mint sends it at once; a rotated one costs one retry again.
  o.advance(3600_000);
  await status(ID, signal());
  expect(o.tokens()).toHaveLength(3);
  o.rotateNonce("nonce-2");
  o.advance(3600_000);
  await status(ID, signal());
  expect(o.tokens()).toHaveLength(5);
  expect(o.problems).toEqual([]);
});

test("with DPoP off at the app the token is Bearer, and calls carry no proof", async () => {
  const o = okta({ dpop: "off" });
  expect(await oktaDirectoryStatus(config, o.options)(ID, signal())).toBe("active");
  expect(o.tokens()).toHaveLength(1);
  expect(o.seen.at(-1)!.auth).toBe("Bearer tok-1");
  expect(o.seen.at(-1)!.dpop).toBeNull();
  expect(o.problems).toEqual([]);
});

test("ACTIVE, LOCKED_OUT, RECOVERY and PASSWORD_EXPIRED are active; SUSPENDED and DEPROVISIONED inactive; the rest unknown", async () => {
  for (const s of ["ACTIVE", "LOCKED_OUT", "RECOVERY", "PASSWORD_EXPIRED"]) expect(await oktaDirectoryStatus(config, okta({ user: user(s) }).options)(ID, signal())).toBe("active");
  for (const s of ["SUSPENDED", "DEPROVISIONED"]) expect(await oktaDirectoryStatus(config, okta({ user: user(s) }).options)(ID, signal())).toBe("inactive");
  for (const s of ["STAGED", "PROVISIONED", "ACTIVATING", "active", ""])
    expect((await failure(oktaDirectoryStatus(config, okta({ user: user(s) }).options)(ID, signal()))).name).toBe("okta_status_unknown");
});

test("Okta's 404 E0000007 is inactive; any other 404 throws", async () => {
  const gone = { status: 404, body: { errorCode: "E0000007", errorSummary: `Not found: Resource not found: ${ID} (User)`, errorLink: "E0000007", errorId: "x", errorCauses: [] } };
  expect(await oktaDirectoryStatus(config, okta({ user: () => gone }).options)(ID, signal())).toBe("inactive");
  for (const reply of [{ status: 404 }, { status: 404, body: "<html>Not Found</html>" }, { status: 404, body: { errorCode: "E0000022" } }])
    expect((await failure(oktaDirectoryStatus(config, okta({ user: () => reply }).options)(ID, signal()))).name).toBe("okta_directory_error");
});

test("every other answer throws, named for what an operator fixes", async () => {
  const cases: [Parameters<typeof okta>[0], string][] = [
    [{ token: () => ({ status: 401, body: { error: "invalid_client", error_description: "The client_assertion signature is invalid." } }) }, "okta_token_refused"],
    [{ token: () => ({ status: 400, body: { error: "invalid_scope", error_description: "The following scopes are not allowed: okta.users.read" } }) }, "okta_token_refused"],
    [{ token: () => ({ status: 400, body: { error: "invalid_dpop_proof" } }) }, "okta_token_refused"],
    // A second use_dpop_nonce after the retry is a refusal, not a loop.
    [{ token: () => ({ status: 400, body: { error: "use_dpop_nonce" }, headers: { "DPoP-Nonce": "n" } }) }, "okta_token_refused"],
    [{ token: () => ({ status: 429, body: { errorCode: "E0000047" } }) }, "okta_directory_error"],
    [{ token: () => ({ status: 503 }) }, "okta_directory_error"],
    [{ token: () => ({ status: 200, body: { access_token: "t", expires_in: 3600 } }) }, "okta_directory_error"],
    [{ token: () => ({ status: 200, body: { access_token: "t", expires_in: 3600, token_type: "N_A" } }) }, "okta_directory_error"],
    [{ token: () => ({ status: 200, body: "<html>" }) }, "okta_directory_error"],
    [{ user: () => ({ status: 401, body: { errorCode: "E0000011", errorSummary: "Invalid token provided" } }) }, "okta_directory_refused"],
    [{ user: () => ({ status: 403, body: { errorCode: "E0000006", errorSummary: "You do not have permission to perform the requested action" } }) }, "okta_directory_refused"],
    [{ user: () => ({ status: 429, body: { errorCode: "E0000047" } }) }, "okta_directory_error"],
    [{ user: () => ({ status: 500 }) }, "okta_directory_error"],
    [{ user: () => ({ status: 200, body: { id: ID } }) }, "okta_directory_error"],
    [{ user: () => ({ status: 200, body: { id: "00uSomeoneElse", status: "SUSPENDED" } }) }, "okta_directory_error"],
    [{ user: () => ({ status: 200, body: [{ id: ID, status: "SUSPENDED" }] }) }, "okta_directory_error"],
    [{ user: () => ({ status: 200, body: "not json" }) }, "okta_directory_error"],
  ];
  for (const [script, name] of cases)
    expect([script, (await failure(oktaDirectoryStatus(config, okta(script).options)(ID, signal()))).name]).toEqual([script, name]);
});

test("a subject that isn't an Okta user id throws without a request: the path would take a login", async () => {
  const o = okta();
  const status = oktaDirectoryStatus(config, o.options);
  for (const subject of ["", ".", "..", "ann@example.com", "ann", "00u", "00u/../x", "00u1%2F", `00u${"a".repeat(253)}`, "0oa1checker"])
    expect((await failure(status(subject, signal()))).name).toBe("okta_directory_error");
  expect(o.seen).toHaveLength(0);
});

test("a token is minted again near its expiry and after a 401; a 403 keeps it; concurrent first calls share one mint", async () => {
  let refuse = false;
  const o = okta({ dpop: "off", user: i => refuse ? { status: 401 } : { status: 200, body: { id: i, status: "ACTIVE" } } });
  const status = oktaDirectoryStatus(config, o.options);
  await Promise.all([status(ID, signal()), status("00uB", signal()), status("00uC", signal())]);
  expect(o.tokens()).toHaveLength(1);
  o.advance(3600_000 - 60_000);
  await status(ID, signal());
  expect(o.tokens()).toHaveLength(2);
  refuse = true;
  await failure(status(ID, signal()));
  refuse = false;
  await status(ID, signal());
  expect(o.tokens()).toHaveLength(3);
  const f = okta({ dpop: "off", user: () => ({ status: 403 }) });
  const forbidden = oktaDirectoryStatus(config, f.options);
  await failure(forbidden(ID, signal()));
  await failure(forbidden(ID, signal()));
  expect(f.tokens()).toHaveLength(1);
});

test("a network failure or refused redirect is okta_directory_error; the caller's abort stays itself; a body over the cap throws", async () => {
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const e = await failure(oktaDirectoryStatus(config, { fetch: down })(ID, signal()));
  expect([e.name, (e.cause as Error).message]).toEqual(["okta_directory_error", "fetch failed"]);
  const caller = new AbortController();
  const o = okta();
  const midRequest = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === TOKEN_URL) return o.options.fetch(input, init);
    caller.abort(new Error("timeout"));
    throw init!.signal!.reason;
  }) as typeof fetch;
  expect((await failure(oktaDirectoryStatus(config, { now: o.options.now, fetch: midRequest })(ID, caller.signal))).message).toBe("timeout");
  const big = okta({ user: () => ({ status: 200, body: "x".repeat(256 * 1024 + 1) }) });
  expect((await failure(oktaDirectoryStatus(config, big.options)(ID, signal()))).name).toBe("okta_directory_error");
});

test("a refused credential logs Okta's error text once per window, never the key or a token", async () => {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warned.push(m); };
  try {
    const o = okta({ token: () => ({ status: 401, body: { error: "invalid_client", error_description: "The client_assertion signature is invalid." } }) });
    const status = oktaDirectoryStatus(config, o.options);
    await failure(status(ID, signal()));
    await failure(status(ID, signal()));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("invalid_client: The client_assertion signature is invalid.");
    expect(warned[0]).not.toContain("PRIVATE KEY");
    o.advance(10 * 60_000);
    await failure(status(ID, signal()));
    expect(warned).toHaveLength(2);
    const d = okta({ dpop: "off", user: () => ({ status: 403, body: { errorCode: "E0000006", errorSummary: "You do not have permission to perform the requested action" } }) });
    await failure(oktaDirectoryStatus(config, d.options)(ID, signal()));
    expect(warned.at(-1)).toContain("E0000006: You do not have permission");
    expect(warned.at(-1)).not.toContain("tok-");
  } finally { console.warn = warn; }
});

test("parseOktaDirectoryKey takes a JWK or a PEM (PKCS#8, PKCS#1, SEC1), as PKCS#8 with the alg its type signs", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pkcs1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const jwk = { ...rsa.privateKey.export({ format: "jwk" }), kid: "console-kid" };
  expect(parseOktaDirectoryKey(pkcs8, undefined)).toEqual({ privateKey: pkcs8, alg: "RS256" });
  expect(parseOktaDirectoryKey(pkcs1, "k1")).toEqual({ privateKey: pkcs8, alg: "RS256", keyId: "k1" });
  expect(parseOktaDirectoryKey(JSON.stringify(jwk), undefined)).toEqual({ privateKey: pkcs8, alg: "RS256", keyId: "console-kid" });
  expect(parseOktaDirectoryKey(JSON.stringify(jwk), "console-kid").keyId).toBe("console-kid");
  for (const [curve, alg] of [["P-256", "ES256"], ["P-384", "ES384"], ["P-521", "ES512"]] as const) {
    const ec = generateKeyPairSync("ec", { namedCurve: curve }).privateKey;
    expect(parseOktaDirectoryKey(ec.export({ type: "sec1", format: "pem" }) as string, undefined).alg).toBe(alg);
  }
  const refusals: [string, string | undefined, RegExp][] = [
    ["not a key", undefined, /is not a JSON Web Key or a PEM private key/],
    ["{", undefined, /is not a JSON Web Key or a PEM private key/],
    [JSON.stringify(await exportJWK((await generateKeyPair("RS256", { extractable: true })).publicKey)), undefined, /without its private part/],
    ["-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----", undefined, /is not a valid private key/],
    [generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string, undefined, /must be an RSA or EC/],
    [pkcs8, "", /KEY_ID must be the key's id/],
    [pkcs8, "a b", /KEY_ID must be the key's id/],
    [JSON.stringify(jwk), "other", /differs from GRAYBOARD_OKTA_DIRECTORY_KEY's kid/],
  ];
  for (const [raw, kid, message] of refusals) {
    const e = (() => { try { parseOktaDirectoryKey(raw, kid); } catch (error) { return error as Error; } throw new Error("expected a refusal"); })();
    expect(e.message).toMatch(message);
    expect(e.message).not.toContain("BEGIN");
  }
  // What it returns signs: the PKCS#8 parses back to the same key.
  expect(createPrivateKey(parseOktaDirectoryKey(pkcs1, undefined).privateKey).export({ format: "jwk" })).toEqual(rsa.privateKey.export({ format: "jwk" }));
});

test("oktaOrgUrl is the origin of an org or custom authorization server issuer", () => {
  expect(oktaOrgUrl("https://example.okta.com")).toBe("https://example.okta.com");
  expect(oktaOrgUrl("https://example.okta.com/oauth2/default")).toBe("https://example.okta.com");
  expect(oktaOrgUrl("https://login.example.com/oauth2/aus1abc")).toBe("https://login.example.com");
  for (const issuer of ["http://example.okta.com", "https://example.okta.com/oauth2", "https://example.okta.com/oauth2/default/x", "https://example.okta.com/realms/eng", "https://u:p@example.okta.com", "https://example.okta.com?x", "nope"])
    expect(oktaOrgUrl(issuer)).toBeNull();
});
