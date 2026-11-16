// A loopback OpenID Connect issuer for the OIDC provider's tests (#928), in the pattern of
// startFakeAnthropic(): discovery, JWKS, an authorize endpoint that redirects back with a code, a token endpoint that
// checks client_secret_basic (each half form-decoded), each code's single use and the PKCE verifier, and userinfo.
// Bad tokens are minted, not stubbed: next() shapes the next ID token, signed with jose.
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload, type KeyLike } from "jose";

export type OidcUser = { sub: string; email?: string; email_verified?: unknown; name?: string };

// The next ID token's shape. `claims` patches the payload (a key set to undefined removes that claim); `alg` and
// `kid` patch the header (`HS256` signs with the client secret, `none` leaves it unsigned); `foreignKey` signs with a
// key the JWKS doesn't publish, under the published kid.
export type NextToken = { claims?: Record<string, unknown>; alg?: string; kid?: string; foreignKey?: boolean };

export type FakeOidcOptions = {
  clientId: string;
  clientSecret: string;
  user: OidcUser;
  // Okta's code flow: the ID token carries no email claims, only userinfo does.
  claimsInUserinfoOnly?: boolean;
};

export type FakeOidc = {
  issuer: string;
  hits: { discovery: number; jwks: number; authorize: number; token: number; userinfo: number; other: number };
  // The Authorization header of each token request, as sent.
  tokenAuthorizations: (string | null)[];
  // Refusals the token endpoint answered, by reason.
  tokenRefusals: string[];
  next(t: NextToken): void;
  // A patch on the discovery document (a key set to undefined removes it), or "fail" for an HTTP 500; null resets.
  discovery(patch: Record<string, unknown> | "fail" | null): void;
  // A patch on every userinfo answer (another `sub`, say); null resets.
  userinfo(patch: Record<string, unknown> | null): void;
  // A raw answer from that endpoint in place of the real one (a redirect, an oversized body); null resets.
  answer(endpoint: "discovery" | "token" | "userinfo", make: ((issuer: string) => Response) | null): void;
  // A new signing key under a new kid; the JWKS publishes only it.
  rotateKeys(): Promise<void>;
  // The next JWKS answer sends its headers and the start of its body, then stalls until released.
  stallJwks(): () => void;
  // Follows an authorize URL the provider built, as a browser would, and returns the callback's parameters.
  authorize(url: string): Promise<URLSearchParams>;
  stop(): void;
};

type Key = { kid: string; privateKey: KeyLike; publicKey: KeyLike };
const newKey = async (kid: string): Promise<Key> => ({ kid, ...await generateKeyPair("RS256") });
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const patched = (base: Record<string, unknown>, patch: Record<string, unknown>) => {
  const out = { ...base, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete out[k];
  return out;
};
// application/x-www-form-urlencoded decoding, strict: a raw `%` that isn't an escape fails.
const formDecode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));

export async function startFakeOidc(o: FakeOidcOptions): Promise<FakeOidc> {
  let key = await newKey("k1");
  const foreign = await newKey("foreign");
  let nextToken: NextToken | undefined;
  let discoveryPatch: Record<string, unknown> | "fail" | null = null;
  let userinfoPatch: Record<string, unknown> | null = null;
  let stall: Promise<void> | undefined;
  const releases: (() => void)[] = [];
  const codes = new Map<string, { nonce: string | null; challenge: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const hits = { discovery: 0, jwks: 0, authorize: 0, token: 0, userinfo: 0, other: 0 };
  const answers: Partial<Record<"discovery" | "token" | "userinfo", (issuer: string) => Response>> = {};
  const tokenAuthorizations: (string | null)[] = [];
  const tokenRefusals: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const path = u.pathname.slice(base.length);
      if (req.method === "GET" && path === "/.well-known/openid-configuration") {
        hits.discovery++;
        if (answers.discovery) return answers.discovery(issuer);
        if (discoveryPatch === "fail") return new Response("down", { status: 500 });
        return Response.json(patched(discoveryDoc(), discoveryPatch ?? {}));
      }
      if (req.method === "GET" && path === "/keys") {
        hits.jwks++;
        const jwks = JSON.stringify({ keys: [{ ...await exportJWK(key.publicKey), kid: key.kid, alg: "RS256", use: "sig" }] });
        if (stall) {
          const held = stall;
          stall = undefined;
          return new Response(new ReadableStream({
            async start(c) { c.enqueue(new TextEncoder().encode(jwks.slice(0, 5))); await held; c.enqueue(new TextEncoder().encode(jwks.slice(5))); c.close(); },
          }), { headers: { "content-type": "application/json" } });
        }
        return new Response(jwks, { headers: { "content-type": "application/json" } });
      }
      if (req.method === "GET" && path === "/authorize") {
        hits.authorize++;
        const p = u.searchParams;
        if (p.get("client_id") !== o.clientId || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") ||
            !p.get("redirect_uri") || !p.get("state") || !p.get("scope")?.split(" ").includes("openid")) return new Response("bad authorize request", { status: 400 });
        const code = randomBytes(16).toString("hex");
        codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge")!, redirectUri: p.get("redirect_uri")! });
        const back = new URL(p.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", p.get("state")!);
        back.searchParams.set("iss", issuer);
        return new Response(null, { status: 302, headers: { Location: back.href } });
      }
      if (req.method === "POST" && path === "/token") {
        hits.token++;
        if (answers.token) return answers.token(issuer);
        const authorization = req.headers.get("authorization");
        tokenAuthorizations.push(authorization);
        const refuse = (error: string, reason: string, status = 400) => { tokenRefusals.push(reason); return Response.json({ error }, { status }); };
        const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization ?? "");
        if (!basic) return refuse("invalid_client", "no basic authentication", 401);
        const pair = Buffer.from(basic[1]!, "base64").toString("utf8");
        const colon = pair.indexOf(":");
        let id: string, secret: string;
        try { id = formDecode(pair.slice(0, colon)); secret = formDecode(pair.slice(colon + 1)); } catch { return refuse("invalid_client", "undecodable client credentials", 401); }
        if (colon < 0 || id !== o.clientId || secret !== o.clientSecret) return refuse("invalid_client", "wrong client credentials", 401);
        const form = new URLSearchParams(await req.text());
        if (form.get("grant_type") !== "authorization_code") return refuse("unsupported_grant_type", "grant type");
        const code = form.get("code") ?? "";
        const grant = codes.get(code);
        codes.delete(code);
        if (!grant) return refuse("invalid_grant", "unknown or used code");
        if (form.get("redirect_uri") !== grant.redirectUri) return refuse("invalid_grant", "redirect_uri");
        if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) return refuse("invalid_grant", "PKCE verifier");
        const accessToken = randomBytes(16).toString("hex");
        accessTokens.add(accessToken);
        const shape = nextToken ?? {};
        nextToken = undefined;
        return Response.json({ token_type: "Bearer", expires_in: 3600, scope: "openid email profile", access_token: accessToken, id_token: await mint(grant.nonce, shape) });
      }
      if (req.method === "GET" && path === "/userinfo") {
        hits.userinfo++;
        if (answers.userinfo) return answers.userinfo(issuer);
        const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
        if (!token || !accessTokens.has(token)) return Response.json({ error: "invalid_token" }, { status: 401 });
        return Response.json(patched({ ...o.user }, userinfoPatch ?? {}));
      }
      hits.other++;
      return new Response("not served by the fake OIDC issuer", { status: 404 });
    },
  });
  const origin: string = `http://127.0.0.1:${server.port}`;
  // A path, as Okta's custom authorization servers have.
  const base = "/oauth2/default";
  const issuer: string = `${origin}${base}`;
  const discoveryDoc = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/keys`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  });

  async function mint(nonce: string | null, shape: NextToken): Promise<string> {
    const t = Math.floor(Date.now() / 1000);
    const identity: Record<string, unknown> = { sub: o.user.sub, name: o.user.name };
    if (!o.claimsInUserinfoOnly) Object.assign(identity, { email: o.user.email, email_verified: o.user.email_verified });
    const payload = patched({ iss: issuer, aud: o.clientId, iat: t, exp: t + 300, ...(nonce === null ? {} : { nonce }), ...identity }, shape.claims ?? {});
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    const alg = shape.alg ?? "RS256";
    const kid = shape.kid ?? key.kid;
    if (alg === "none") return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.`;
    if (alg.startsWith("HS")) return new SignJWT(payload as JWTPayload).setProtectedHeader({ alg, kid }).sign(new TextEncoder().encode(o.clientSecret));
    return new SignJWT(payload as JWTPayload).setProtectedHeader({ alg, kid }).sign((shape.foreignKey ? foreign : key).privateKey);
  }

  return {
    issuer,
    hits,
    tokenAuthorizations,
    tokenRefusals,
    next(t) { nextToken = t; },
    discovery(patch) { discoveryPatch = patch; },
    userinfo(patch) { userinfoPatch = patch; },
    answer(endpoint, make) { if (make) answers[endpoint] = make; else delete answers[endpoint]; },
    async rotateKeys() { key = await newKey(`k${Number(key.kid.slice(1)) + 1}`); },
    stallJwks() {
      let release!: () => void;
      stall = new Promise<void>(r => { release = r; });
      releases.push(release);
      return release;
    },
    async authorize(url) {
      const res = await fetch(url, { redirect: "manual" });
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) throw new Error(`fake OIDC authorize answered ${res.status}: ${await res.text()}`);
      return new URL(location).searchParams;
    },
    stop() { for (const r of releases) r(); server.stop(true); },
  };
}
