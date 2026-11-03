// hosted-core's shared hosted session (client.ts, HostedClient) and root
// delivery (root.ts, RootDelivery) in-process against a real server whose
// public URL is its listen address, signed in with a grant seeded for the
// built-in pi client (#444). Covers what every hosted harness now gets from
// one place: a credential drift's pauses left to the sign-out, the
// lock-or-wait handoff, a carried name taken and refused, detach and release,
// admit refused once the run loop's signal aborts, the notice slots' order and
// supersession, a child's call through HostedClient.call, and the shutdown
// releasing the lease while a start is still connecting.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { HostedClient, type Level } from "../../adapters/hosted-core/src/client.ts";
import { Controller } from "../../adapters/hosted-core/src/controller.ts";
import { Login } from "../../adapters/hosted-core/src/login.ts";
import { DeliveryHeldElsewhere, Refusal, type Item } from "../../adapters/hosted-core/src/model.ts";
import { ToolProxy } from "../../adapters/hosted-core/src/proxy.ts";
import { RootDelivery, type RootOptions } from "../../adapters/hosted-core/src/root.ts";
import { deliveryPath, writeJsonAtomic } from "../../adapters/hosted-core/src/storage.ts";
import { hostedSessionId } from "../../src/server/hosted.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { hostedServer, seedGrant, type HostedServer } from "../support/hosted_oauth.ts";
import { until } from "../support/until.ts";

const CLIENT = "grayboard-pi";
const EMAIL = "alice@example.com";
const SCOPES = ["grayboard:delivery", "grayboard:tools"];
const HELD = new DeliveryHeldElsewhere("pi").message;
const SIGNED_OUT = "Signed out of grayboard in pi; run /grayboard login";

let srv: HostedServer, stateDir: string, user: number;
const rigs: Rig[] = [];

beforeEach(async () => {
  srv = hostedServer();
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gb-hosted-root-")));
  mkdirSync(stateDir, { recursive: true });
  user = (await seedGrant(srv, stateDir, CLIENT, EMAIL)).authed.user_id;
});
afterEach(async () => {
  await Promise.all(rigs.splice(0).map(r => r.root.shutdown("release")));
  await srv.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

const storeLogin = () => new Login({ resource: srv.resource, clientId: CLIENT, stateDir, harness: "pi", loginAction: "run /grayboard login", present: () => {}, notify: () => {}, diagnostic: () => {} });

// One hosted session's client as pi builds it, logging what it would say.
function client(logs: { message: string; level: Level }[]) {
  return new HostedClient({
    harness: "pi", clientId: CLIENT, version: "1.0.0", login: storeLogin(), source: "grayboard",
    loginAction: "run /grayboard login", resumeHint: "run /grayboard resume", retryHint: "call the tool again",
    log: (message, level) => { logs.push({ message, level }); },
  });
}

type Rig = { id: string; client: HostedClient; root: RootDelivery; logs: { message: string; level: Level }[]; admitted: Item[] };
function rig(id: string, o: Partial<Pick<RootOptions, "carried" | "admit">> = {}): Rig {
  const logs: Rig["logs"] = [], admitted: Item[] = [];
  const c = client(logs);
  const root = new RootDelivery(c, {
    sessionID: id, stateDir, place: () => "hosted-core-root test", push: true,
    ...(o.carried ? { carried: o.carried } : {}),
    admit: o.admit ?? (async item => { admitted.push(item); }),
    onTools: () => {},
  });
  const r = { id, client: c, root, logs, admitted };
  rigs.push(r);
  return r;
}

const texts = (result: CallToolResult) => result.content.flatMap(block => block.type === "text" ? [block.text] : []);
const record = (r: Rig) => r.root.status().controller?.roots.find(x => x.sessionID === r.id);
const active = (r: Rig, name: string) => until(() => record(r)?.state === "active" && record(r)?.held?.[0] === `${EMAIL}/${name}`, 10_000, `${r.id} active as ${name}`);
async function live(id: string, name: string) {
  const r = rig(id);
  await r.root.start();
  const bound = await r.root.call("bind", { name, create: true });
  expect(bound.isError, texts(bound).join("\n")).toBeUndefined();
  await active(r, name);
  return r;
}

type Row = { name: string | null; lease_deadline: number | null };
// A hosted root's holds are alias_holds rows (#451); `name` is its primary (oldest) hold.
const row = (raw: string): Row | null => {
  const id = hostedSessionId(user, CLIENT, raw);
  const r = srv.app.db.query<{ lease_deadline: number | null }, [string]>("SELECT lease_deadline FROM hosted_sessions WHERE session_id = ?").get(id);
  const hold = srv.app.db.query<{ address: string }, [string]>("SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address").get(id);
  return r && { lease_deadline: r.lease_deadline, name: hold ? hold.address.slice(hold.address.lastIndexOf("/") + 1) : null };
};

// Another pi process on this state dir: a sign-in writes a new epoch and
// grant to the shared store; a sign-out revokes and logs the store out.
async function loginElsewhere(epoch: string) {
  const issued = issueOAuth(srv.app.repo, srv.resource, EMAIL, SCOPES, Date.now(), CLIENT);
  await writeJsonAtomic(storeLogin().path, { version: 1, resource: srv.resource, clientId: CLIENT, epoch, issuer: srv.issuer, scope: SCOPES.join(" "),
    access: issued.token, accessExpiresAt: Date.now() + 3_600_000, refresh: issued.refreshToken });
}

test("a credential drift's pause is the sign-out's to say: one line, no pause notice in it or the next tool result; a sign-in elsewhere restarts the root once", async () => {
  const a = await live("drift-1", "drifter");
  const resume = spyOn(Controller.prototype, "resume");
  try {
    await storeLogin().logout();
    await until(() => record(a)?.state === "paused", 10_000, "paused by the drift");
    await until(() => a.logs.length > 0, 10_000, "the sign-out said");
    const result = await a.root.call("whoami");
    expect(result.isError).toBe(true);
    expect(texts(result).join("\n")).not.toContain("delivery paused");
    expect(a.logs).toEqual([{ level: "warning", message: SIGNED_OUT }]);

    const before = resume.mock.calls.length;
    await loginElsewhere("drift-relogin");
    // Running again, unbound: a new sign-in never inherits the old grant's name.
    await until(() => record(a)?.state === "unbound", 10_000, "restarted after the sign-in");
    // One epoch-guarded restart, whichever trigger saw the sign-in first.
    expect(resume.mock.calls.length - before).toBe(1);
  } finally { resume.mockRestore(); }
  expect(a.logs).toEqual([{ level: "warning", message: SIGNED_OUT }]);
}, 30_000);

test("a root whose delivery another holder has runs tools-only, refuses bind, and takes delivery when the holder lets go; the held notice nobody saw is dropped", async () => {
  const a = await live("wait-1", "holder");
  const b = rig("wait-1");
  await b.root.start();
  expect(b.root.status().held).toBe(HELD);
  const refused = await b.root.call("bind", { name: "intruder", create: true });
  expect(texts(refused)).toEqual([`error: ${HELD}; bind and unbind work from the process that holds delivery`]);

  await a.root.shutdown("detach");
  // waitDelivery retries every 5 s.
  await until(() => record(b)?.state === "active", 15_000, "the waiter's takeover");
  await active(b, "holder");
  expect(b.root.status().held).toBeUndefined();
  const result = await b.root.call("whoami");
  expect(texts(result).filter(t => t.startsWith("grayboard: "))).toEqual([]);
  expect(row("wait-1")).toMatchObject({ name: "holder" });
}, 30_000);

test("a root in lock error whose resume finds delivery held elsewhere is held, not in error: the error's unseen notice is dropped for the held one", async () => {
  const path = deliveryPath(stateDir, srv.resource, CLIENT, "relock-1");
  mkdirSync(path, { recursive: true });
  const a = rig("relock-1");
  await a.root.start();
  expect(a.root.status().error).toStartWith("couldn't take delivery: ");
  expect(a.root.status().held).toBeUndefined();

  rmSync(path, { recursive: true });
  await live("relock-1", "holder");
  await a.root.resume();
  expect(a.root.status()).toEqual({ held: HELD });
  const result = await a.root.call("whoami");
  expect(texts(result).filter(t => t.startsWith("grayboard: "))).toEqual([`grayboard: ${HELD}`]);
}, 30_000);

test("a bind whose `before` retries a lock error and finds delivery held elsewhere is refused: the holder keeps its name", async () => {
  const path = deliveryPath(stateDir, srv.resource, CLIENT, "bindrace-1");
  mkdirSync(path, { recursive: true });
  const b = rig("bindrace-1");
  await b.root.start();
  expect(b.root.status().error).toStartWith("couldn't take delivery: ");
  rmSync(path, { recursive: true });
  await live("bindrace-1", "holder");
  // The plugin's before(): unpause retries the lock error.
  const result = await b.root.call("bind", { name: "intruder", create: true }, async () => { await b.root.resume(); return undefined; });
  expect(texts(result)).toEqual([`error: ${HELD}; bind and unbind work from the process that holds delivery`]);
  expect(row("bindrace-1")).toMatchObject({ name: "holder" });
}, 30_000);

test("a held root shut down while its tools-only connect is in flight doesn't say it couldn't reach the server, and a sign-in racing a shutdown never reopens the closed connection", async () => {
  const a = await live("earlyquit-1", "holder");
  const b = rig("earlyquit-1");
  await b.root.start();
  expect(b.root.status().held).toBe(HELD);
  await b.root.shutdown("release");
  const changing = a.root.credentialChanged();
  await a.root.shutdown("release");
  await changing;
  expect([...a.logs, ...b.logs].filter(l => l.message.startsWith("couldn't reach the server"))).toEqual([]);
  expect(row("earlyquit-1")).toBeNull();
}, 30_000);

test("a carried name a start takes is said nowhere; one the server refuses is said once and in the next tool result only", async () => {
  const first = await live("carry-1", "carrier");
  const carried = await first.root.shutdown("release", { carry: true });
  expect(carried).toEqual([`${EMAIL}/carrier`]);
  const taker = rig("carry-2", { carried });
  await taker.root.start();
  await active(taker, "carrier");
  expect(taker.logs).toEqual([]);
  expect(texts(await taker.root.call("whoami")).filter(t => t.startsWith("grayboard: "))).toEqual([]);
  expect(row("carry-2")).toMatchObject({ name: "carrier" });

  await live("taken-1", "taken");
  const refused = rig("taken-2", { carried: [`${EMAIL}/taken`] });
  await refused.root.start();
  const said = /^this session couldn't take the name alice@example\.com\/taken it carried over \(.*alias_held.*\); it is unbound$/;
  expect(refused.logs).toEqual([{ level: "warning", message: expect.stringMatching(said) }]);
  const next = texts(await refused.root.call("whoami"));
  expect(next[0]).toMatch(new RegExp(`^grayboard: ${said.source.slice(1)}`));
  expect(texts(await refused.root.call("whoami")).filter(t => t.startsWith("grayboard: "))).toEqual([]);
});

test("detach keeps the lease and name for the next runtime; release ends the session", async () => {
  const a = await live("detach-1", "keeper");
  await a.root.shutdown("detach");
  expect(row("detach-1")).toMatchObject({ name: "keeper" });
  expect(row("detach-1")!.lease_deadline).not.toBeNull();
  const b = rig("detach-1");
  await b.root.start();
  await active(b, "keeper");
  await b.root.shutdown("release");
  expect(row("detach-1")).toBeNull();
  expect([...a.logs, ...b.logs]).toEqual([]);
});

test("admit gets the run loop's signal; once it aborts, the host's admit is never called", async () => {
  const signals: AbortSignal[] = [];
  let port: unknown;
  const restore = Controller.prototype.restore;
  const spy = spyOn(Controller.prototype, "restore").mockImplementation(async function (this: Controller) {
    // The port root.ts built (private on the Controller): its admit wrapper is under test.
    port = Reflect.get(this, "port");
    return restore.call(this);
  });
  const a = rig("admit-1", { admit: async (_item, _stableID, _identity, signal) => { signals.push(signal); } });
  try { await a.root.start(); } finally { spy.mockRestore(); }
  const bound = await a.root.call("bind", { name: "admitter", create: true });
  expect(bound.isError).toBeUndefined();
  await active(a, "admitter");
  const sender = await live("admit-sender", "sender");
  expect((await sender.root.call("dm_send", { to: "admitter", body: "admit me" })).isError).toBeUndefined();
  await until(() => signals.length === 1, 10_000, "the admit");
  expect(signals[0]!.aborted).toBe(false);
  await a.root.shutdown("release");
  expect(signals[0]!.aborted).toBe(true);

  if (!(port && typeof port === "object" && "admit" in port && typeof port.admit === "function")) throw new Error("the Controller's port has no admit");
  const item: Item = { id: "direct:1", actionable: true, event: {}, ownership: 1, bind_gen: 1, address: `${EMAIL}/admitter` };
  const refused: unknown = await port.admit(undefined, item, "stable", undefined, AbortSignal.abort()).then(() => undefined, (error: unknown) => error);
  expect(refused).toBeInstanceOf(Refusal);
  expect(refused).toMatchObject({ code: "paused", message: "the pi session closed" });
  expect(signals).toHaveLength(1);
});

test("notices are keyed slots shown with the next tool result: held, then the host's first, then its last, then the call's own; a later text replaces a slot's, and they show once", async () => {
  await live("slots-1", "slotted");
  const b = rig("slots-1");
  await b.root.start();
  b.root.noticeOnce("first, superseded", "first");
  b.root.noticeOnce("first", "first");
  b.root.noticeOnce("last", "last");
  const result = await b.root.call("whoami", {}, async () => "before the call");
  expect(texts(result).slice(0, 4)).toEqual([`grayboard: ${HELD}`, "grayboard: first", "grayboard: last", "grayboard: before the call"]);
  expect(texts(await b.root.call("whoami")).filter(t => t.startsWith("grayboard: "))).toEqual([]);
});

test("a child's calls go through HostedClient.call: a refused register and a JSON-RPC error come back as error results with the retry hint and their message", async () => {
  const logs: { message: string; level: Level }[] = [];
  const c = client(logs);
  const proxy = c.proxy("poll", { hooks: { beforeCall: async () => { throw new Error("registration refused"); }, afterCall: async () => {} }, onTools: () => {} });
  try {
    await c.connect(proxy);
    expect(await c.call(proxy, "whoami", {}, "child-1")).toEqual({ isError: true, content: [{ type: "text", text: "error: Operation failed; call the tool again (registration refused)" }] });
    const plain = c.proxy("poll", { onTools: () => {} });
    try {
      await c.connect(plain);
      const unknown = await c.call(plain, "no_such_tool", {}, "child-1");
      expect(unknown.isError).toBe(true);
      expect(texts(unknown)).toEqual([expect.stringMatching(/^error: Operation failed; call the tool again \(.*no_such_tool.*\)$/)]);
    } finally { await c.close(plain); }
  } finally { await c.close(proxy); }
  expect(logs).toEqual([]);
});

test("a thrown call's own message in its error result has its control and bidi characters replaced and is capped", async () => {
  const c = client([]);
  const result = await c.call({ call: async () => { throw new Error(`\x1b[31mrefused\u202e\x07${"x".repeat(4096)}`); } }, "whoami", {}, "child-1");
  expect(result.isError).toBe(true);
  const [text] = texts(result);
  expect(text).toStartWith("error: Operation failed; call the tool again ( [31mrefused  xxx");
  expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  expect(text).toEndWith("x…)");
  expect(text!.length).toBeLessThan(400);
});

test("a sign-in store the root can't read for its epoch is said once, however many starts read it", async () => {
  const read = spyOn(Login.prototype, "read").mockRejectedValue(new Error("store unreadable"));
  try {
    const a = rig("epoch-1");
    await a.root.start();
    await a.root.resume();
    expect(a.logs.filter(l => l.message.startsWith("couldn't read the sign-in store"))).toEqual([{ level: "warning", message: "couldn't read the sign-in store: store unreadable" }]);
  } finally { read.mockRestore(); }
});

test("a shutdown while a start's push connection is still connecting releases the lease first, then closes the connection that start built", async () => {
  await (await live("first-1", "first")).root.shutdown("detach");
  expect(row("first-1")!.lease_deadline).not.toBeNull();

  const real = globalThis.fetch;
  let armed = true;
  const { promise: hold, resolve: open } = Promise.withResolvers<void>();
  const { promise: holding, resolve: hit } = Promise.withResolvers<void>();
  // The first native (non-subscriber) request after the start: the push
  // proxy's connect, inside own().
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (armed && new Headers(init?.headers).get("X-Grayboard-Client") !== "subscriber") { armed = false; hit(); await hold; }
    return real(input, init);
  }) as typeof fetch);
  const closed: ToolProxy[] = [];
  const close = ToolProxy.prototype.close;
  const closeSpy = spyOn(ToolProxy.prototype, "close").mockImplementation(async function (this: ToolProxy) {
    closed.push(this);
    return close.call(this);
  });
  const made: ToolProxy[] = [];
  const proxy = HostedClient.prototype.proxy;
  const proxySpy = spyOn(HostedClient.prototype, "proxy").mockImplementation(function (this: HostedClient, mode, o) {
    const p = proxy.call(this, mode, o);
    if (mode === "push") made.push(p);
    return p;
  });
  let down: Promise<string | undefined> | undefined;
  try {
    const b = rig("first-1");
    const started = b.root.start();
    await holding;
    down = b.root.shutdown("release");
    await until(() => row("first-1") === null, 10_000, "the session ended while the connect is held");
    expect(made).toHaveLength(1);
    expect(closed).not.toContain(made[0]);
    open();
    await started;
    await down;
    expect(closed).toContain(made[0]);
    expect(b.logs).toEqual([]);
  } finally {
    open();
    await down;
    fetchSpy.mockRestore();
    closeSpy.mockRestore();
    proxySpy.mockRestore();
  }
});
