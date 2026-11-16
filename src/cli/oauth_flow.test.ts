// The CLI's own checks on its sign-in (#928 D8), against a fake authorization server and a scripted "browser" that
// calls the CLI's loopback callback directly: the metadata's origin, the callback's state filter, the RFC 9207 iss
// check, and the refusal text it prints. The real AS end to end is tests/integration/cli_login.test.ts.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { loginThroughServer } from "./oauth_flow.ts";

type Fake = { issuer: string; tokenCalls: URLSearchParams[]; meta: Record<string, unknown>; stop(): void };
let as: Fake, log: ReturnType<typeof spyOn>;

function fakeServer(): Fake {
  const tokenCalls: URLSearchParams[] = [];
  const fake = { tokenCalls, meta: {} as Record<string, unknown> } as Fake;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/.well-known/oauth-authorization-server") return Response.json(fake.meta);
    if (path === "/token") { tokenCalls.push(new URLSearchParams(await req.text())); return Response.json({ access_token: "gbrd_v1_test", token_type: "Bearer" }); }
    return new Response(null, { status: 404 });
  } });
  fake.issuer = `http://127.0.0.1:${server.port}`;
  fake.meta = { issuer: fake.issuer, authorization_endpoint: fake.issuer + "/authorize", token_endpoint: fake.issuer + "/token", code_challenge_methods_supported: ["S256"], grayboard_cli_client: "grayboard-cli" };
  fake.stop = () => void server.stop(true);
  return fake;
}

// The browser: once the CLI opens the authorize URL, calls its redirect_uri with each answer in turn (the flow's state
// unless one names another), recording each response's status.
function browser(answers: Record<string, string>[], statuses: number[] = []) {
  return (url: string) => {
    const authorize = new URL(url);
    void (async () => {
      for (const answer of answers) {
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, ...answer }).toString();
        statuses.push(await fetch(callback).then(r => r.status, () => 0));
      }
    })();
  };
}

beforeEach(() => { as = fakeServer(); log = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { as.stop(); log.mockRestore(); });

test("a code with the server's iss and the flow's state is redeemed for the CLI's token", async () => {
  expect(await loginThroughServer(as.issuer, browser([{ code: "the-code", iss: as.issuer }]))).toBe("gbrd_v1_test");
  expect(Object.fromEntries(as.tokenCalls[0]!)).toMatchObject({ grant_type: "authorization_code", client_id: "grayboard-cli", code: "the-code" });
});

test("a response naming another issuer is refused before any code is redeemed (RFC 9207)", async () => {
  await expect(loginThroughServer(as.issuer, browser([{ code: "the-code", iss: "http://127.0.0.1:1" }]))).rejects.toThrow("sign-in response came from an unexpected issuer");
  await expect(loginThroughServer(as.issuer, browser([{ code: "the-code" }]))).rejects.toThrow("unexpected issuer");
  expect(as.tokenCalls).toEqual([]);
});

test("a callback carrying another state is answered 400 and ignored; the flow's own answer still lands", async () => {
  const statuses: number[] = [];
  const open = browser([{ state: "someone-elses", error: "access_denied", iss: as.issuer }, { code: "the-code", iss: as.issuer }], statuses);
  expect(await loginThroughServer(as.issuer, open)).toBe("gbrd_v1_test");
  expect(statuses).toEqual([400, 200]);
});

test("a server whose metadata doesn't name grayboard-cli is refused as too old before the browser opens (#991)", async () => {
  delete as.meta.grayboard_cli_client;
  await expect(loginThroughServer(as.issuer, () => { throw new Error("the browser opened"); })).rejects.toThrow(`${as.issuer} is too old for this CLI's sign-in`);
  as.meta.grayboard_cli_client = "grayboard-pi";
  await expect(loginThroughServer(as.issuer, () => { throw new Error("the browser opened"); })).rejects.toThrow("too old");
});

test("metadata naming an endpoint on another origin is refused before the browser opens", async () => {
  for (const key of ["issuer", "authorization_endpoint", "token_endpoint"]) {
    const meta = { ...as.meta };
    as.meta[key] = "http://127.0.0.1:1/elsewhere";
    // Opening the browser fails the flow at once, so a missing check can't leave it waiting for the timeout.
    await expect(loginThroughServer(as.issuer, () => { throw new Error("the browser opened"); })).rejects.toThrow("OAuth metadata names another origin (http://127.0.0.1:1)");
    as.meta = meta;
  }
});

test("an access_denied refusal prints the server's reason as printable text, capped", async () => {
  const reason = "this account is disabled on this server";
  await expect(loginThroughServer(as.issuer, browser([{ error: "access_denied", error_description: reason, iss: as.issuer }]))).rejects.toThrow(`sign-in was refused: ${reason}`);
  await expect(loginThroughServer(as.issuer, browser([{ error: "access_denied", iss: as.issuer }]))).rejects.toThrow(/^sign-in was denied$/);
  const hostile = "\x1b]0;owned\x07\x1b[2Jline one\r\nline two‮" + "x".repeat(1000);
  const refused = await loginThroughServer(as.issuer, browser([{ error: "access_denied", error_description: hostile, iss: as.issuer }])).catch((e: Error) => e.message);
  expect(refused).toStartWith("sign-in was refused: ");
  expect(refused).not.toMatch(/[\x00-\x1f\x7f-\x9f‮]/);
  expect(refused).toContain("line one line two");
  expect(refused.length).toBeLessThan(400);
  // Any other error code is printed the same way.
  const other = await loginThroughServer(as.issuer, browser([{ error: "server_error\x1b[31m", iss: as.issuer }])).catch((e: Error) => e.message);
  expect(other).toBe("sign-in failed (server_error [31m)");
  expect(as.tokenCalls).toEqual([]);
});
