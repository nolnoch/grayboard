// #581 offer.ts: one flow per record (joined, not replaced), what a signed-out
// call's result says for each way the flow goes, the state scrub, and the
// latest outcome's record.
import { expect, test } from "bun:test";
import { AccessExpired } from "../src/model.ts";
import { describeLast, LINK_MS, notify, offer, present, SCRUBBED, start, type Flow, type Outcome, type SignInState, type Signer } from "../src/offer.ts";

const notes = { started: "STARTED", starting: "STARTING" };
const URL_ = "https://gb.example/oauth/authorize?state=s3cret&code_challenge=c";

// A Signer whose token says signed out (or signed in) and whose login is
// settled by the test.
function signer(signedIn = false) {
  const calls: { signal?: AbortSignal; ifSignedOut?: boolean }[] = [];
  const settle = Promise.withResolvers<void>();
  const s: Signer = {
    token: async () => { if (signedIn) return "tok"; throw new AccessExpired("pi", "run /grayboard login"); },
    login: (signal, ifSignedOut) => {
      calls.push({ signal, ifSignedOut });
      signal?.addEventListener("abort", () => settle.reject(new Error("aborted")), { once: true });
      return settle.promise;
    },
  };
  return { s, calls, ok: () => settle.resolve(), fail: (e: unknown) => settle.reject(e) };
}
function run(state: SignInState, s: Signer, ended: (f: Flow, o: Outcome) => void = () => {}) {
  return start(state, s, { origin: "offer", browser: false, ifSignedOut: true, ended });
}
const call = (state: SignInState, s: Signer, linkMs = 50, interactive = true) =>
  offer(state, s, { interactive, begin: () => run(state, s), notes, linkMs });

test("a second start joins the pending flow; its end clears the record and records the outcome", async () => {
  const state: SignInState = {}, f = signer();
  const ends: Outcome[] = [];
  const flow = run(state, f.s, (_, o) => { ends.push(o); });
  expect(start(state, f.s, { origin: "command", browser: true, ifSignedOut: false, ended: () => {} })).toBe(flow);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.ifSignedOut).toBe(true);
  f.ok();
  await flow.done;
  expect(ends).toEqual(["signed in"]);
  expect(state.flow).toBeUndefined();
  expect(state.last).toMatchObject({ origin: "offer", outcome: "signed in" });
  expect(state.last!.said).toBeUndefined();
  expect(describeLast(state.last!)).toMatch(/^last sign-in: offer at \d{4}-\d\d-\d\dT[\d:.]+Z: signed in$/);
});

test("signed in, not interactive, or a transient failure: no offer and no flow", async () => {
  const state: SignInState = {};
  expect(await call(state, signer(true).s)).toBeUndefined();
  expect(await call(state, signer().s, 50, false)).toBeUndefined();
  const transient: Signer = { token: async () => { throw new Error("HTTP 502"); }, login: () => { throw new Error("never"); } };
  expect(await call(state, transient)).toBeUndefined();
  expect(state.flow).toBeUndefined();
});

test("a URL within the wait: the started note, never the URL", async () => {
  const state: SignInState = {}, f = signer();
  const pending = call(state, f.s, 5_000);
  await Promise.resolve();
  present(state, URL_);
  const text = await pending;
  expect(text).toBe("STARTED");
  expect(state.flow!.url).toBe(URL_);
  f.ok();
});

test("the flow ends signed in before a URL (a waiter shares the holder's grant): no note", async () => {
  const state: SignInState = {}, f = signer();
  const pending = call(state, f.s, 5_000);
  await Promise.resolve();
  f.ok();
  expect(await pending).toBeUndefined();
});

test("the flow fails: its reason, with a reason quoting the flow's state replaced", async () => {
  let state: SignInState = {}, f = signer();
  let pending = call(state, f.s, 5_000);
  await Promise.resolve();
  f.fail(new Error("sign-in was denied"));
  expect(await pending).toBe("sign-in failed: sign-in was denied");
  expect(state.last!.outcome).toBe("failed: sign-in was denied");

  state = {}; f = signer();
  const flow = run(state, f.s);
  present(state, URL_);
  f.fail(new Error(`prompt error at ${URL_.slice(0, 50)}`));
  await flow.done;
  expect(flow.failed).toBe(SCRUBBED);
  expect(state.last!.outcome).toBe(`failed: ${SCRUBBED}`);
});

test("the flow is aborted (closing): no note, recorded cancelled", async () => {
  const state: SignInState = {}, f = signer();
  const pending = call(state, f.s, 5_000);
  await Promise.resolve();
  state.flow!.abort.abort();
  expect(await pending).toBeUndefined();
  expect(state.last!.outcome).toBe("cancelled");
});

test("another process holds the flow: the elsewhere text only when no URL came by the wait", async () => {
  const state: SignInState = {}, f = signer();
  const flow = run(state, f.s);
  notify(state, "sign-in in progress in another pi session");
  // notify leaves the link open: a waiter's present still reaches the race.
  const pending = call(state, f.s, 5_000);
  await Promise.resolve();
  present(state, URL_);
  expect(await pending).toBe("STARTED");
  // A record with no URL yet: the wait runs out, then the elsewhere text.
  const other: SignInState = {}, g = signer();
  run(other, g.s);
  notify(other, "sign-in in progress in another pi session");
  const at = Date.now();
  expect(await call(other, g.s, 80)).toBe("sign-in in progress in another pi session; finish it there, then call a grayboard tool again");
  expect(Date.now() - at).toBeGreaterThanOrEqual(75);
  f.ok(); g.ok();
  await flow.done;
});

test("no URL and nothing else by the wait: the starting note", async () => {
  const state: SignInState = {}, f = signer();
  expect(await call(state, f.s, 30)).toBe("STARTING");
  expect(state.flow).toBeDefined();
  f.ok();
});

test("the default wait is 20 s", () => { expect(LINK_MS).toBe(20_000); });
