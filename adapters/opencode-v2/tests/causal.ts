import assert from "node:assert/strict";
import { barrier } from "./reload-state.js";

// The producer boundary must cover every controlled delivery, not just entry into synthetic().
export async function afterProducers(producers: () => Promise<void>, drain: () => Promise<unknown>, check: () => void) {
  await producers();
  await drain();
  check();
}

export function rootStatus<T extends { sessionID?: string }>(status: { roots: readonly T[] }, sessionID: string): T | undefined {
  return status.roots.find(root => root.sessionID === sessionID);
}

export function rootRetrying(status: { roots: readonly { sessionID?: string; state: string; operation: string; code?: string }[] }, sessionID: string): boolean {
  const root = rootStatus(status, sessionID);
  return root?.state === "retrying" && root.operation === "reopen" && root.code === "operation_failed";
}

type AdmissionRequest = { id?: unknown; method?: string; params?: { name?: string; _meta?: Record<string, unknown> } };
type Refusal = { root: string; role: "subscriber"; operation: "delivery_renew"; id: string | number; at: number; status: 429; retryAfterMs: number };

// Only an actual selected-root response can establish this fixture's throttle precondition.
export class SubscriberAdmission {
  readonly entered = barrier();
  readonly retryEntered = barrier();
  private readonly initialRelease = barrier();
  private readonly retryRelease = barrier();
  private selected = false;
  private completed = false;
  private closed = false;
  get retryForwarded() { return this.completed; }
  private id?: string | number;
  private refusal?: Readonly<Refusal>;
  readonly frozenAt: number;
  constructor(readonly root: string, private readonly now: () => number) { this.frozenAt = now(); }
  private async hold(pending: Promise<void>, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort!: () => void;
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      })]);
      signal.throwIfAborted();
      assert(!this.closed, "admission barrier closed before forwarding");
    } finally { signal.removeEventListener("abort", abort); }
  }
  releaseInitial() { assert(this.selected, "expected-root subscriber request not held"); this.initialRelease.release(); }
  requireRefused(): Readonly<Refusal> {
    assert(this.refusal, "no genuine selected-root subscriber HTTP429 observed");
    return this.refusal;
  }
  releaseRecovery() {
    this.requireRefused();
    assert(this.now() > this.frozenAt, "refill must follow the selected-root refusal");
    this.retryRelease.release();
  }
  close() { this.closed = true; this.initialRelease.release(); this.retryRelease.release(); }
  async forward(request: Request, body: AdmissionRequest | undefined, forward: () => Promise<Response>): Promise<Response> {
    const selected = request.method === "POST" && request.headers.get("X-Grayboard-Client") === "subscriber" &&
      body?.method === "tools/call" && body.params?.name === "delivery_renew" && body.params._meta?.["ai.opencode/sessionID"] === this.root;
    if (!selected || this.completed) return forward();
    if (this.selected) {
      assert.equal(body!.id, this.id, "expected the original subscriber retry continuation");
      this.requireRefused();
      this.retryEntered.release();
      await this.hold(this.retryRelease.promise, request.signal);
      this.completed = true;
      return forward();
    }
    assert(typeof body!.id === "string" || typeof body!.id === "number", "subscriber request needs an RPC id");
    this.id = body!.id; this.selected = true; this.entered.release();
    await this.hold(this.initialRelease.promise, request.signal);
    assert.equal(this.now(), this.frozenAt, "refill moved before the selected request reached admission");
    const response = await forward();
    assert.equal(response.status, 429, "held subscriber must receive an actual HTTP429");
    const envelope = await response.clone().json() as { id?: unknown; error?: { code?: number; data?: { code?: string; retry_after_ms?: number } } };
    assert.equal(envelope.id, this.id);
    assert.equal(envelope.error?.code, -32000);
    assert.equal(envelope.error.data?.code, "rate_limited");
    const retry = envelope.error.data.retry_after_ms;
    assert(typeof retry === "number" && Number.isFinite(retry) && retry > 0);
    assert.equal(response.headers.get("Retry-After"), String(Math.ceil(retry / 1000)));
    assert.equal(this.now(), this.frozenAt, "refill moved before the subscriber refusal was observed");
    this.refusal = Object.freeze({ root: this.root, role: "subscriber", operation: "delivery_renew", id: this.id, at: this.frozenAt, status: 429, retryAfterMs: retry });
    return response;
  }
}
