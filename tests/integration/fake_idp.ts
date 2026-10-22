// Just enough OpenID provider for the sign-in tests: a JWKS and a token
// endpoint that redeems codes the test issued, over Bun.serve. One instance
// stands in for Google and Entra alike; the claims a test issues decide which.
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import type { IdpEndpoints } from "../../src/server/config.ts";

const KID = "fake-1";

export class FakeIdp {
  /** Form bodies the token endpoint received, oldest first. */
  readonly tokenCalls: Record<string, string>[] = [];
  /** Answer this many token requests with a 503. */
  failToken = 0;
  private readonly codes = new Map<string, string>();
  private next = 0;
  readonly server: ReturnType<typeof Bun.serve>;

  private constructor(private readonly key: KeyLike, private readonly rogue: KeyLike, jwk: object) {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/jwks") return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
        if (url.pathname === "/token" && req.method === "POST") {
          const form = Object.fromEntries(new URLSearchParams(await req.text()));
          this.tokenCalls.push(form);
          if (this.failToken > 0) { this.failToken--; return new Response("unavailable", { status: 503 }); }
          const idToken = this.codes.get(form.code ?? "");
          if (!idToken) return Response.json({ error: "invalid_grant" }, { status: 400 });
          this.codes.delete(form.code!);
          return Response.json({ id_token: idToken, access_token: "unused", token_type: "Bearer" });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }

  static async start(): Promise<FakeIdp> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const rogue = await generateKeyPair("RS256");
    return new FakeIdp(privateKey, rogue.privateKey, await exportJWK(publicKey));
  }

  get endpoints(): IdpEndpoints {
    const base = `http://localhost:${this.server.port}`;
    return { authorize: `${base}/authorize`, token: `${base}/token`, jwks: `${base}/jwks` };
  }

  /** A code that redeems to an ID token with these claims (iss and aud included). forged: signed by a key not in the JWKS. */
  async issue(claims: Record<string, unknown>, opts: { forged?: boolean } = {}): Promise<string> {
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(opts.forged ? this.rogue : this.key);
    const code = `code-${++this.next}`;
    this.codes.set(code, idToken);
    return code;
  }

  stop(): void { this.server.stop(true); }
}
