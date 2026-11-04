// One process's sign-in (#499, #581), shared by pi/omp (adapters/pi-family)
// and Claude Code (plugins/claude-code): the flow a `/grayboard login`, a
// signed-out tool call's offer or a signed-out start runs, what a waiting
// call's result says about it, and the latest outcome for status.
//
// Stateless functions over a plain record the adapter keeps: pi and omp keep
// it in their per-harness globalThis slot, so a flow outlives the runtime
// that started it, and a /reload may load this module anew against the
// record an older bundle made. So the record holds data and promises, never
// an instance whose methods one bundle would call on another's behalf. The
// module never logs: each adapter says outcomes through its `ended` hook.
import { message } from "./client.js";
import { accessExpiry } from "./model.js";

export type Origin = "offer" | "command" | "startup";
export type Outcome = "signed in" | "cancelled" | `failed: ${string}`;
// The latest flow's end. `said` is set by whoever said its outcome, so it is
// said once (a `/grayboard login` waiting on the flow skips its own line).
export type Last = { origin: Origin; outcome: Outcome; at: number; said?: true };
// A flow. `link` resolves with the first authorization URL it shows (`url` is
// the latest), or undefined once it ends without one. `elsewhere` says
// another process's flow holds the store's login lock. `outcome` is set once
// it ended: "current" when an automatic one found the store already signed
// in, which records no Last and runs no `ended` (nothing happened to say).
export type Flow = {
  origin: Origin;
  abort: AbortController;
  done: Promise<void>;
  link: Promise<string | undefined>;
  show(url: string | undefined): void;
  url?: string;
  browser: boolean;
  elsewhere?: string;
  failed?: string;
  outcome?: Outcome | "current";
};
export type SignInState = { flow?: Flow; last?: Last };
// What `start` drives: hosted-core's Login, or a fake in tests.
export type Signer = { login(signal?: AbortSignal, ifSignedOut?: boolean): Promise<"signed in" | "current">; token(): Promise<string> };

// How long a signed-out call waits for its flow's link: past discovery's two
// 10 s request timeouts the server is likely down, and the result says the
// sign-in is still starting rather than hold the call.
export const LINK_MS = 20_000;
// What replaces a failure's text that carries the flow's `state`, the part a
// login CSRF needs: a host's prompt error may quote the URL.
export const SCRUBBED = "the sign-in prompt failed";

// Login's `present`, before the adapter's own side effects: the pending
// flow's URL. Returns the flow, if any.
export function present(state: SignInState, url: string): Flow | undefined {
  const flow = state.flow;
  if (flow) { flow.url = url; flow.show(url); }
  return flow;
}
// Login's `notify`: another process's flow holds the lock. It doesn't settle
// `link`: that waiter may yet show the holder's URL.
export function notify(state: SignInState, message: string): Flow | undefined {
  const flow = state.flow;
  if (flow) flow.elsewhere = message;
  return flow;
}

// The pending flow, else a new one. `ifSignedOut` returns at once once the
// store holds a live grant (an offer, a signed-out start); `/grayboard login`
// runs a flow regardless. `ended` runs once the flow's end is recorded.
export function start(state: SignInState, login: Signer, o: { origin: Origin; browser: boolean; ifSignedOut: boolean; ended(flow: Flow, outcome: Outcome): void | Promise<void> }): Flow {
  if (state.flow) return state.flow;
  const abort = new AbortController();
  let show!: (url: string | undefined) => void;
  const link = new Promise<string | undefined>(resolve => { show = resolve; });
  const flow: Flow = { origin: o.origin, abort, link, show, browser: o.browser, done: Promise.resolve() };
  state.flow = flow;
  const finish = (outcome: Outcome | "current") => {
    flow.outcome = outcome;
    show(undefined);
    if (state.flow === flow) state.flow = undefined;
  };
  const settle = (outcome: Outcome) => {
    state.last = { origin: flow.origin, outcome, at: Date.now() };
    finish(outcome);
    return o.ended(flow, outcome);
  };
  flow.done = login.login(abort.signal, o.ifSignedOut).then(
    result => result === "signed in" ? settle("signed in") : finish("current"),
    error => {
      if (abort.signal.aborted) return settle("cancelled");
      flow.failed = scrub(flow, message(error));
      return settle(`failed: ${flow.failed}`);
    },
  );
  // An `ended` hook that throws rejects `done` for whoever awaits it.
  flow.done.catch(() => {});
  return flow;
}

// The wording that differs per harness: where the user finds the link.
export type Notes = { started: string; starting: string };

// What a call's result says about its sign-in: undefined while signed in or
// after a transient failure (the call reports that), and when the flow
// ended signed in or was cancelled; else that the user has the link (waiting
// up to `linkMs` for the flow to reach one), why the flow failed, or that it
// waits on another process's or is still starting. The link itself never
// enters the text (#500). `begin` starts or joins the flow, or returns
// undefined where none may run.
export async function offer(state: SignInState, login: Signer, o: { interactive: boolean; begin(): Flow | undefined; notes: Notes; linkMs?: number }): Promise<string | undefined> {
  try { await login.token(); return undefined; }
  catch (error) { if (!accessExpiry(error) || !o.interactive) return undefined; }
  const flow = o.begin();
  if (!flow) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), o.linkMs ?? LINK_MS); timer.unref?.(); });
  const url = await Promise.race([flow.link, late]).finally(() => clearTimeout(timer));
  return note(flow, url, o.notes);
}

export function note(flow: Flow, url: string | undefined, notes: Notes): string | undefined {
  if (flow.outcome === "signed in" || flow.outcome === "current" || flow.outcome === "cancelled") return undefined;
  if (flow.outcome) return `sign-in failed: ${flow.failed}`;
  if (url) return notes.started;
  if (flow.elsewhere) return `${flow.elsewhere}; finish it there, then call a grayboard tool again`;
  return notes.starting;
}

// `/grayboard status`'s line for the latest flow.
export function describeLast(last: Last): string {
  return `last sign-in: ${last.origin} at ${new Date(last.at).toISOString()}: ${last.outcome}`;
}

function scrub(flow: Flow, why: string): string {
  if (!flow.url) return why;
  let secret: string | undefined;
  try { secret = new URL(flow.url).searchParams.get("state") || flow.url; } catch { secret = flow.url; }
  return why.includes(secret) ? SCRUBBED : why;
}
