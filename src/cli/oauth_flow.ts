// `grayboard login` as a client of the server's OAuth authorization server
// (#928 D8): the client grayboard-cli, a loopback redirect on an ephemeral
// port (RFC 8252), PKCE and state, the scope grayboard:login and no resource.
// The server's token endpoint answers that code with the CLI's API token
// (gbrd_v1_), which the credentials file holds as before. Which IdP the person
// signs in with is the server's business, not this binary's.
import { createHash, randomBytes } from "node:crypto";
import { openBrowser } from "../shared/browser.ts";

// The server's constants (src/server/oauth-config.ts); the CLI doesn't import server code.
const CLI_CLIENT_ID = "grayboard-cli";
const LOGIN_SCOPE = "grayboard:login";
const FLOW_MS = 5 * 60_000;

// The server's words reach the terminal only as printable text: control characters (escape sequences
// among them) become spaces, and the length is capped.
const printable = (text: string, max = 300) => {
  const clean = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
};

type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; code_challenge_methods_supported?: string[]; grayboard_cli_client?: unknown };

const page = (title: string) => new Response(`<!doctype html><meta charset="utf-8"><title>Grayboard</title><h1>${title}</h1><p>You may close this tab and return to your terminal.</p>`,
  { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

// RFC 8414 §3: an issuer with a path has its metadata under the origin's well-known path.
async function metadata(serverUrl: string): Promise<Metadata> {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/$/, "");
  let res: Response;
  try { res = await fetch(`${u.origin}/.well-known/oauth-authorization-server${path}`, { signal: AbortSignal.timeout(10_000), redirect: "error" }); }
  catch (e) { throw new Error(`couldn't reach ${serverUrl} (${(e as Error).message})`); }
  if (!res.ok) throw new Error(`${serverUrl} has no OAuth authorization server (HTTP ${res.status}): it isn't a grayboard server, or one older than v2.0.0, too old for this CLI's sign-in (upgrade it, or sign in with grayboard CLI v2.4.2)`);
  const m = await res.json().catch(() => ({})) as Partial<Metadata>;
  if (typeof m.issuer !== "string" || typeof m.authorization_endpoint !== "string" || typeof m.token_endpoint !== "string") throw new Error(`${serverUrl} sent malformed OAuth metadata`);
  // The endpoints must be this server's: the browser and the code go nowhere else.
  for (const e of [m.issuer, m.authorization_endpoint, m.token_endpoint]) if (new URL(e).origin !== u.origin) throw new Error(`${serverUrl}'s OAuth metadata names another origin (${new URL(e).origin})`);
  if (!m.code_challenge_methods_supported?.includes("S256")) throw new Error(`${serverUrl}'s OAuth server doesn't offer PKCE S256`);
  // A server older than #928 doesn't know grayboard-cli: its authorize page refuses the client with no redirect, and
  // the flow would wait out FLOW_MS (#991). v2.4.2 is the last CLI that signs in the old way.
  if (m.grayboard_cli_client !== CLI_CLIENT_ID) throw new Error(`${serverUrl} is too old for this CLI's sign-in: upgrade the server, or sign in with grayboard CLI v2.4.2`);
  return m as Metadata;
}

// Resolves with the loopback callback's parameters once a request carries this flow's state; a request with
// another state is answered and ignored. Bound to 127.0.0.1 only: the redirect names it.
function loopback(state: string): { redirectUri: string; result: Promise<URLSearchParams>; close(): Promise<void> } {
  let settle!: (p: URLSearchParams) => void;
  const result = new Promise<URLSearchParams>(resolve => { settle = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== "/callback") return new Response("not found", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("Unknown sign-in", { status: 400 });
      settle(url.searchParams);
      return page(url.searchParams.has("code") && !url.searchParams.has("error") ? "Signed in to grayboard" : "Grayboard sign-in did not complete");
    },
  });
  // Stopped without force and awaited, so the page above reaches the browser before the CLI exits; a
  // connection still open after a second is cut.
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([server.stop(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer);
    void server.stop(true);
  };
  return { redirectUri: `http://127.0.0.1:${server.port}/callback`, result, close };
}

/** Signs in through `serverUrl`'s authorization server and returns the CLI's API token. `open` shows the
 *  authorize URL (the system browser by default). */
export async function loginThroughServer(serverUrl: string, open: (url: string) => void = url => openBrowser(url)): Promise<string> {
  const meta = await metadata(serverUrl);
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url");
  const callback = loopback(state);
  let params: URLSearchParams;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: CLI_CLIENT_ID, redirect_uri: callback.redirectUri, scope: LOGIN_SCOPE, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    console.log(`\nOpening your browser to sign in to ${serverUrl}...`);
    console.log(`If it did not open, visit:\n${url.href}\n`);
    open(url.href);
    params = await Promise.race([callback.result, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("sign-in timed out (5 minutes)")), FLOW_MS); })]);
  } finally {
    clearTimeout(timer);
    await callback.close();
  }
  // RFC 9207: the response names its issuer, so another server's code can't land here.
  if (params.get("iss") !== meta.issuer) throw new Error("sign-in response came from an unexpected issuer");
  const error = params.get("error");
  if (error !== null) {
    if (error !== "access_denied") throw new Error(`sign-in failed (${printable(error)})`);
    const description = printable(params.get("error_description") ?? "");
    throw new Error(description ? `sign-in was refused: ${description}` : "sign-in was denied");
  }
  const code = params.get("code");
  if (!code) throw new Error("sign-in response carried no code");
  let res: Response;
  try {
    res = await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, redirect: "error", signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLI_CLIENT_ID, code, code_verifier: verifier, redirect_uri: callback.redirectUri }) });
  } catch (e) { throw new Error(`couldn't reach ${serverUrl}'s token endpoint (${(e as Error).message})`); }
  const body = await res.json().catch(() => ({})) as { access_token?: unknown; error?: unknown };
  if (res.status !== 200) throw new Error(`the server refused the sign-in code (HTTP ${res.status}${typeof body.error === "string" ? `: ${printable(body.error)}` : ""})`);
  if (typeof body.access_token !== "string" || !body.access_token.startsWith("gbrd_v1_")) throw new Error("the server's token response carried no grayboard token");
  return body.access_token;
}
