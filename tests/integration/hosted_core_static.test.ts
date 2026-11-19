// hosted-core's static service run-token mode (#1243, static.ts) against a real
// server whose public URL is its listen address: the environment rules
// (staticMode), the issuer pin and principal check before the token is sent
// anywhere, a RootDelivery bound as the service's BUS_IDENTITY name and
// receiving a push, a 401 ending the run with no retry, a stored browser grant
// left untouched, and no file holding the token.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { HostedClient, type Level } from "../../adapters/hosted-core/src/client.ts";
import { AccessExpired, Refusal } from "../../adapters/hosted-core/src/model.ts";
import { RootDelivery } from "../../adapters/hosted-core/src/root.ts";
import { NEW_RUN, StaticLogin, staticMode, type StaticMode } from "../../adapters/hosted-core/src/static.ts";
import { ServerUnreachable } from "../../adapters/hosted-core/src/wire.ts";
import { hostedRowCount } from "../support/hosted_rows.ts";
import { hostedServer, seedGrant, storeLogin, tokenRequests, type HostedServer } from "../support/hosted_oauth.ts";
import { serviceRun } from "../support/service_token.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi", ROOT = "root@example.com", EMAIL = "alice@example.com", SVC = "ingest";
const ENDED = `Signed out of grayboard in pi; ${NEW_RUN}`;

let srv: HostedServer, dir: string;
const roots: RootDelivery[] = [];
beforeEach(() => {
  srv = hostedServer({ admins: [ROOT] });
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gb-static-")));
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map(r => r.shutdown("release")));
  await srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

const mode = (env: Record<string, string>): StaticMode => {
  const m = staticMode(env, dir);
  if (!m) throw new Error("static mode off");
  return m;
};
const signIn = (m: StaticMode, resource = srv.resource) => new StaticLogin({ resource, clientId: CLIENT, version: "1.0.0", harness: "pi", mode: m });

// Every request this process sends from now on, with whether it carried a bearer.
function outgoing() {
  const seen: { url: string; bearer: boolean }[] = [];
  const real = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const headers = new Headers(init?.headers ?? request.headers);
    seen.push({ url: request.url, bearer: /^Bearer /.test(headers.get("authorization") ?? "") });
    return real(input as RequestInfo, init);
  }) as typeof fetch);
  return { seen, restore: () => spy.mockRestore() };
}

describe("staticMode: the launcher's environment only", () => {
  const TOKEN = "a".repeat(40);
  const on = { GRAYBOARD_AUTH: "static", GRAYBOARD_ISSUER: "https://gb.example.com", GRAYBOARD_RUN_TOKEN: TOKEN };

  test("unset is OAuth; the pin or principal alone are ignored; a run token without the mode is refused", () => {
    expect(staticMode({}, dir)).toBeUndefined();
    expect(staticMode({ GRAYBOARD_ISSUER: "https://gb.example.com", GRAYBOARD_PRINCIPAL: SVC }, dir)).toBeUndefined();
    expect(staticMode({ GRAYBOARD_RUN_TOKEN: TOKEN }, dir)).toEqual({ refused: "GRAYBOARD_RUN_TOKEN is set without GRAYBOARD_AUTH=static" });
  });

  test("on: issuer and token, the principal optional; each malformed input refuses", () => {
    expect(staticMode(on, dir)).toEqual({ issuer: "https://gb.example.com", token: TOKEN });
    expect(staticMode({ ...on, GRAYBOARD_PRINCIPAL: SVC }, dir)).toEqual({ issuer: "https://gb.example.com", token: TOKEN, principal: SVC });
    expect(staticMode({ ...on, GRAYBOARD_ISSUER: "http://127.0.0.1:9" }, dir)).toMatchObject({ issuer: "http://127.0.0.1:9" });
    const refused = (env: Record<string, string>) => (staticMode(env, dir) as { refused: string }).refused;
    expect(refused({ ...on, GRAYBOARD_AUTH: "oauth" })).toBe('GRAYBOARD_AUTH must be "static" or unset');
    expect(refused({ GRAYBOARD_AUTH: "static", GRAYBOARD_RUN_TOKEN: TOKEN })).toContain("needs a pinned issuer");
    for (const issuer of ["http://gb.example.com", "https://u:p@gb.example.com", "https://gb.example.com?x=1", "not a url"]) expect(refused({ ...on, GRAYBOARD_ISSUER: issuer })).toContain("must be an HTTPS URL");
    expect(refused({ GRAYBOARD_AUTH: "static", GRAYBOARD_ISSUER: "https://gb.example.com" })).toContain("needs the launcher's run token");
    for (const token of ["short", "a b".repeat(10), "x".repeat(513)]) expect(refused({ ...on, GRAYBOARD_RUN_TOKEN: token })).toBe("GRAYBOARD_RUN_TOKEN isn't a run token");
    expect(refused({ ...on, GRAYBOARD_PRINCIPAL: "a/b" })).toBe("GRAYBOARD_PRINCIPAL must be a service name");
    // No refusal quotes the token.
    for (const env of [{ ...on, GRAYBOARD_AUTH: "x" }, { ...on, GRAYBOARD_RUN_TOKEN: `${TOKEN} ` }]) expect(refused(env)).not.toContain(TOKEN);
  });

  test("a repository's dotenv file or Claude Code project settings that set a variable refuse the mode", () => {
    writeFileSync(join(dir, ".env.local"), "OTHER=1\nexport GRAYBOARD_ISSUER=https://evil.example.com\n");
    expect(staticMode(on, dir)).toEqual({ refused: "Static mode refused: .env.local in the working directory sets its variables; the launcher sets them" });
    rmSync(join(dir, ".env.local"));
    writeFileSync(join(dir, ".env"), "OTHER=1\n");
    expect(staticMode(on, dir)).toMatchObject({ token: TOKEN });
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ env: { GRAYBOARD_RUN_TOKEN: "x".repeat(20) } }));
    // Only where the host names a settings dir (Claude Code's project).
    expect(staticMode(on, dir)).toMatchObject({ token: TOKEN });
    expect(staticMode(on, dir, dir)).toEqual({ refused: "Static mode refused: the project's .claude/settings.json sets its variables; the launcher sets them" });
    rmSync(join(dir, ".claude", "settings.json"));
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ env: { GRAYBOARD_AUTH: "static" } }));
    expect(staticMode(on, dir, dir)).toEqual({ refused: "Static mode refused: the project's .claude/settings.local.json sets its variables; the launcher sets them" });
  });
});

describe("before the token is sent", () => {
  test("a pin on another origin, metadata naming another issuer, or a 4xx at the metadata refuse, with no request carrying the token; the refusal is remembered", async () => {
    const run = await serviceRun(srv);
    const net = outgoing();
    try {
      const other = signIn(mode({ ...run.env, GRAYBOARD_ISSUER: srv.issuer.replace("127.0.0.1", "localhost") }));
      await expect(other.token()).rejects.toThrow("isn't on");
      const elsewhere = signIn(mode({ ...run.env, GRAYBOARD_ISSUER: `${srv.issuer}/other` }));
      await expect(elsewhere.token()).rejects.toThrow("doesn't name the pinned issuer");
      const missing = signIn(mode(run.env), `${srv.issuer}/nowhere`);
      await expect(missing.token()).rejects.toBeInstanceOf(Refusal);
      const before = net.seen.length;
      await expect(missing.token()).rejects.toBeInstanceOf(Refusal);
      expect(net.seen.length).toBe(before);
      expect(net.seen.filter(r => r.bearer)).toEqual([]);
    } finally { net.restore(); }
  });

  test("an outage at the metadata is ServerUnreachable and isn't remembered: a later token() succeeds", async () => {
    const run = await serviceRun(srv);
    const real = globalThis.fetch;
    let failures = 1;
    const spy = spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("/.well-known/oauth-protected-resource") && failures-- > 0) return Promise.resolve(new Response("down", { status: 503 }));
      return real(input as RequestInfo, init);
    }) as typeof fetch);
    try {
      const s = signIn(mode(run.env));
      await expect(s.token()).rejects.toBeInstanceOf(ServerUnreachable);
      expect(await s.token()).toBe(run.token);
    } finally { spy.mockRestore(); }
  });

  test("whoami must name a service, the launcher's when GRAYBOARD_PRINCIPAL is set; asking it starts no hosted session", async () => {
    const run = await serviceRun(srv);
    const rows = hostedRowCount(srv.app.db);
    const person = (await seedGrant(srv, dir, CLIENT, EMAIL)).token;
    await expect(signIn(mode({ ...run.env, GRAYBOARD_RUN_TOKEN: person })).token()).rejects.toThrow("isn't a service's");
    const second = await serviceRun(srv, { service: "billing" });
    await expect(signIn(mode({ ...second.env, GRAYBOARD_PRINCIPAL: SVC })).token()).rejects.toThrow("is service billing's, not ingest's");
    // Unset, any service's token passes.
    const { GRAYBOARD_PRINCIPAL: _, ...anyService } = second.env;
    expect(await signIn(mode(anyService)).token()).toBe(second.token);
    expect(hostedRowCount(srv.app.db)).toBe(rows);
  });
});

type Rig = { root: RootDelivery; client: HostedClient; logs: { message: string; level: Level }[] };
function rig(login: StaticLogin, id: string, configured?: string): Rig {
  const logs: Rig["logs"] = [];
  const client = new HostedClient({
    harness: "pi", clientId: CLIENT, version: "1.0.0", login, source: "grayboard",
    loginAction: NEW_RUN, resumeHint: "run /grayboard resume", retryHint: "call the tool again",
    log: (message, level) => { logs.push({ message, level }); },
  });
  const root = new RootDelivery(client, {
    sessionID: id, stateDir: dir, place: () => "hosted-core static test", push: true, ...(configured ? { configured } : {}),
    admit: async () => {}, onTools: () => {},
  });
  roots.push(root);
  return { root, client, logs };
}
const texts = (r: CallToolResult) => r.content.flatMap(b => b.type === "text" ? [b.text] : []);
const record = (r: Rig, id: string) => r.root.status().controller?.roots.find(x => x.sessionID === id);

describe("a run on a run token", () => {
  test("binds the service's BUS_IDENTITY name, holds a lease under the svc_ client, and receives a push", async () => {
    const run = await serviceRun(srv);
    const admitted: unknown[] = [];
    const login = signIn(mode(run.env));
    const logs: Rig["logs"] = [];
    const client = new HostedClient({ harness: "pi", clientId: CLIENT, version: "1.0.0", login, source: "grayboard", loginAction: NEW_RUN, resumeHint: "r", retryHint: "c", log: (message, level) => { logs.push({ message, level }); } });
    const root = new RootDelivery(client, { sessionID: "svc-root-1", stateDir: dir, place: () => "t", push: true, configured: "w-1", admit: async item => { admitted.push(item.event); }, onTools: () => {} });
    roots.push(root);
    await root.start();
    const r = { root, client, logs };
    await until(() => record(r, "svc-root-1")?.state === "active" && record(r, "svc-root-1")?.held?.[0] === `${SVC}/w-1`, 15_000, "active as ingest/w-1");
    const row = srv.app.db.query<{ client_id: string; lease_deadline: number | null }, [string]>("SELECT client_id, lease_deadline FROM hosted_sessions WHERE source_session_id = ?").get("svc-root-1");
    expect(row?.client_id).toBe(run.clientId);
    expect(row?.lease_deadline).not.toBeNull();
    const peer = await serviceRun(srv);
    const other = new StaticLogin({ resource: srv.resource, clientId: CLIENT, version: "1.0.0", harness: "pi", mode: mode(peer.env) });
    const peerRig = rig(other, "svc-peer-1", "w-0");
    await peerRig.root.start();
    await until(() => record(peerRig, "svc-peer-1")?.state === "active", 15_000, "the peer active");
    const sent = await peerRig.root.call("dm_send", { to: `${SVC}/w-1`, body: "work for w-1" });
    expect(sent.isError, texts(sent).join("\n")).toBeUndefined();
    await until(() => JSON.stringify(admitted).includes("work for w-1"), 15_000, "the DM pushed to w-1");
    expect(logs.filter(l => l.level !== "info")).toEqual([]);
  }, 60_000);

  test("a revoked run token ends the run: the root pauses login_required, a call answers the new-run text, and nothing retries", async () => {
    const run = await serviceRun(srv);
    const r = rig(signIn(mode(run.env)), "svc-401-1", "w-1");
    await r.root.start();
    await until(() => record(r, "svc-401-1")?.state === "active", 15_000, "active");
    const tokens = tokenRequests(srv);
    await run.revoke();
    await until(() => record(r, "svc-401-1")?.state === "paused", 15_000, "paused by the 401");
    expect(record(r, "svc-401-1")?.message).toBe(ENDED);
    // One warning line, no sign-in offer or link.
    await until(() => r.logs.length > 0, 10_000, "the pause said");
    expect(r.logs).toEqual([{ level: "warning", message: `delivery paused: ${ENDED}` }]);
    const net = outgoing();
    try {
      const result = await r.root.call("whoami", {});
      expect(result.isError).toBe(true);
      expect(texts(result).join("\n")).toContain(ENDED);
      await r.root.resume();
      expect(record(r, "svc-401-1")?.state).toBe("paused");
      // token() throws before any request: nothing went out after the 401.
      expect(net.seen.filter(x => x.bearer)).toEqual([]);
    } finally { net.restore(); }
    expect(tokens()).toEqual([]);
    expect(r.logs.filter(l => l.message.includes(NEW_RUN)).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("a run token revoked before the start: the first request's 401 pauses the root, and a later runtime in the process sends nothing", async () => {
    const run = await serviceRun(srv);
    await run.revoke();
    const r = rig(signIn(mode(run.env)), "svc-dead-1", "w-1");
    await r.root.start();
    await until(() => r.root.status().signedOut !== undefined || record(r, "svc-dead-1")?.state === "paused", 15_000, "paused at the start");
    const net = outgoing();
    try {
      const again = signIn(mode(run.env));
      await expect(again.token()).rejects.toBeInstanceOf(AccessExpired);
      expect(net.seen).toEqual([]);
    } finally { net.restore(); }
  }, 30_000);
});

describe("nothing else is touched", () => {
  test("a stored browser grant is left byte-identical by static and refused static modes, with no refresh or revoke; login() and logout() refuse", async () => {
    await seedGrant(srv, dir, CLIENT, EMAIL, -1);
    const path = storeLogin(srv, dir, CLIENT).path;
    const before = readFileSync(path);
    const tokens = tokenRequests(srv);
    const run = await serviceRun(srv);
    const r = rig(signIn(mode(run.env)), "svc-grant-1", "w-1");
    await r.root.start();
    await until(() => record(r, "svc-grant-1")?.state === "active", 15_000, "active");
    const refused = signIn({ refused: "GRAYBOARD_AUTH must be \"static\" or unset" });
    await expect(refused.token()).rejects.toThrow('GRAYBOARD_AUTH must be "static" or unset');
    await expect(signIn(mode(run.env)).login()).rejects.toBeInstanceOf(Refusal);
    await expect(signIn(mode(run.env)).logout()).rejects.toBeInstanceOf(Refusal);
    expect(readFileSync(path)).toEqual(before);
    expect(tokens().filter(t => t !== "client_credentials")).toEqual([]);
  }, 30_000);

  test("no file under the state dir holds the run token, and the delivery lock is keyed apart from a person's", async () => {
    const run = await serviceRun(srv);
    const r = rig(signIn(mode(run.env)), "svc-files-1", "w-1");
    await r.root.start();
    await until(() => record(r, "svc-files-1")?.state === "active", 15_000, "active");
    await r.root.shutdown("release");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, "utf8")).not.toContain(run.token);
    expect(signIn(mode(run.env)).stateKey).toBe(`service-credential:${CLIENT}`);
  }, 30_000);
});
