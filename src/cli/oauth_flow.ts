import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(64)).slice(0, 128);
}

function computeCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

export type OAuthResult = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

/** Runs a PKCE loopback OAuth flow. Resolves with the authorization code. */
export function runOAuthFlow(googleClientId: string, serverPublicUrl: string, orgDomain?: string): Promise<OAuthResult> {
  return new Promise((resolve, reject) => {
    const codeVerifier   = generateCodeVerifier();
    const codeChallenge  = computeCodeChallenge(codeVerifier);
    const state          = generateState();

    let httpServer: ReturnType<typeof Bun.serve> | null = null;

    const timeout = setTimeout(() => {
      httpServer?.stop();
      reject(new Error("OAuth flow timed out (5 minutes)"));
    }, 5 * 60 * 1000);

    httpServer = Bun.serve({
      port: 0, // OS-assigned
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/cb") return new Response("not found", { status: 404 });

        const code  = url.searchParams.get("code");
        const rxState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          httpServer?.stop();
          clearTimeout(timeout);
          reject(new Error(`OAuth error: ${error}`));
          return new Response("<html><body>Login failed. You may close this tab.</body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (rxState !== state || !code) {
          httpServer?.stop();
          clearTimeout(timeout);
          reject(new Error("Invalid OAuth callback (state mismatch)"));
          return new Response("<html><body>Invalid callback. You may close this tab.</body></html>", {
            headers: { "Content-Type": "text/html" },
          });
        }

        const redirectUri = `http://127.0.0.1:${httpServer!.port}/cb`;
        clearTimeout(timeout);

        // Resolve before stopping so the response is sent first
        setTimeout(() => httpServer?.stop(), 100);

        resolve({ code, codeVerifier, redirectUri });
        return new Response(
          "<html><body><strong>Login successful!</strong> You may close this tab.</body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      },
    });

    const redirectUri = `http://127.0.0.1:${httpServer.port}/cb`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id",             googleClientId);
    authUrl.searchParams.set("redirect_uri",          redirectUri);
    authUrl.searchParams.set("response_type",         "code");
    authUrl.searchParams.set("scope",                 "openid email profile");
    if (orgDomain) authUrl.searchParams.set("hd", orgDomain);
    authUrl.searchParams.set("code_challenge",        codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state",                 state);
    authUrl.searchParams.set("prompt",                "select_account");

    console.log(`\nOpening browser for Google login...`);
    console.log(`If the browser did not open, visit:\n${authUrl.toString()}\n`);
    openBrowser(authUrl.toString());
  });
}
