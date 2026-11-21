// #930 A2b: Google's directory check against a scripted token endpoint and users.get, with a key made per run.
import { beforeAll, expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair, jwtVerify, type KeyLike } from "jose";
import { DIRECTORY_SCOPE, GOOGLE_TOKEN_URL, googleDirectoryStatus, parseDirectoryKey } from "./idp_google_directory.ts";

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
  const status = googleDirectoryStatus(parseDirectoryKey(keyJson(), undefined), g.options);
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
  await googleDirectoryStatus(parseDirectoryKey(keyJson(), "admin@example.com"), g.options)("1", signal());
  expect((await jwtVerify(g.tokens()[0]!.assertion!, pub, { currentDate: new Date(1_000_000_000_000) })).payload.sub).toBe("admin@example.com");
});

test("suspended, archived and a 404 are inactive", async () => {
  for (const reply of [{ status: 200, body: { suspended: true, archived: false } }, { status: 200, body: { suspended: false, archived: true } }, { status: 404, body: { error: { code: 404 } } }]) {
    const g = google({ user: () => reply });
    expect(await googleDirectoryStatus(parseDirectoryKey(keyJson(), undefined), g.options)("1", signal())).toBe("inactive");
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
    [{ user: () => ({ status: 200, body: "not json" }) }, "SyntaxError"],
  ];
  for (const [script, name] of cases) {
    const g = google(script);
    expect((await failure(googleDirectoryStatus(parseDirectoryKey(keyJson(), undefined), g.options)("1", signal()))).name).toBe(name);
  }
});

test("a token is minted again near its expiry and after a 401; concurrent first calls share one mint", async () => {
  let refuse = false;
  const g = google({ user: () => refuse ? { status: 401 } : { status: 200, body: { suspended: false } } });
  const status = googleDirectoryStatus(parseDirectoryKey(keyJson(), undefined), g.options);
  await Promise.all([status("a", signal()), status("b", signal()), status("c", signal())]);
  expect(g.tokens()).toHaveLength(1);
  g.advance(3600_000 - 60_000);
  await status("a", signal());
  expect(g.tokens()).toHaveLength(2);
  refuse = true;
  await failure(status("a", signal()));
  refuse = false;
  await status("a", signal());
  expect(g.tokens()).toHaveLength(3);
});

test("the subject is one path segment, however it's spelled", async () => {
  const g = google();
  await googleDirectoryStatus(parseDirectoryKey(keyJson(), undefined), g.options)("../x?y", signal());
  expect(g.seen.at(-1)!.url).toBe("https://api.test/admin/directory/v1/users/..%2Fx%3Fy?fields=suspended,archived");
});

test("a key that isn't a service account's RSA key, or an admin that isn't an email, is refused at startup", async () => {
  const ec = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
  for (const [raw, admin, msg] of [
    ["{", undefined, /is not JSON/],
    [keyJson({ type: "authorized_user" }), undefined, /must be a service account key/],
    [keyJson({ client_email: undefined }), undefined, /has no client_email/],
    [keyJson({ private_key: undefined }), undefined, /has no private_key/],
    [keyJson({ private_key: "garbage" }), undefined, /not an RSA private key/],
    [keyJson({ private_key: ec }), undefined, /not an RSA private key/],
    [keyJson(), "admin", /must be an admin's email/],
    [keyJson(), "", /must be an admin's email/],
  ] as const) expect(() => parseDirectoryKey(raw, admin)).toThrow(msg);
  // The refusal never echoes the key.
  try { parseDirectoryKey(keyJson({ private_key: "SECRETSECRET" }), undefined); } catch (e) { expect((e as Error).message).not.toContain("SECRET"); }
});
