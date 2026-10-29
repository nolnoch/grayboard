import type { Context } from "@opencode/plugin/promise/plugin";
import { ServerUnreachable, SubscriberError, holderText } from "./wire.js";
import { NativeAccessExpired } from "./model.js";

export type RecordStatus = { state: string; message: string; sessionID?: string; time: number; name?: string; ownership?: number; operation: string; code?: string; failure?: { operation: string; code: string; time: number } };
export type Status = { state: string; message: string; sessionID?: string; roots: RecordStatus[] };
export type DiagnosticSink = (record: Readonly<RecordStatus>) => void | Promise<void>;
export class DeliveryStopped extends Error {
  constructor(readonly item?: string) { super("Delivery retry budget exhausted"); }
}
const key = "diagnostics:v1";
const fields = ["state", "message", "sessionID", "time", "name", "ownership", "operation", "code", "failure"];
const states = new Set(["approved", "active", "paused", "unbound", "unenrolled", "retrying", "rebinding", "degraded"]);
const operations = new Set(["diagnostic_save", "diagnostic_emit", "pause", "configured_bind", "delivery", "enroll", "prepare", "subscriber", "reopen", "restore", "event", "stream", "before_bind", "after", "hook_dispose", "rpc_dispose", "latch_save", "wire_close", "subscription_close", "delivery_release", "session_end", "pause_save", "child_end", "watch_dispose"]);
const codes = new Set(["retry_exhausted", "operation_failed", "identity_unknown", "identity_in_use", "not_found", "unbound", "refused", "internal_error", "bad_request", "unauthenticated", "forbidden", "rate_limited", "receipt_capacity", "invalid_response", "server_unreachable", "native_access_expired"]);
export function failureCode(error: unknown): string {
  if (error instanceof DeliveryStopped) return "retry_exhausted";
  if (error instanceof ServerUnreachable) return "server_unreachable";
  if (error instanceof NativeAccessExpired) return "native_access_expired";
  if (error instanceof SubscriberError) {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof code === "string" && codes.has(code)) return code;
  }
  return "operation_failed";
}
export function failureMessage(error: unknown): string {
  if (error instanceof DeliveryStopped) return `Retry limit reached${error.item ? ` for ${error.item}; item remains unreceipted` : " before inbox progress"}; explicitly enroll again`;
  if (error instanceof ServerUnreachable) return "Server unreachable; retrying, approval retained";
  if (error instanceof SubscriberError) {
    const code = failureCode(error);
    const known = Object.getOwnPropertyDescriptor(error, "known")?.value;
    const holder = Object.getOwnPropertyDescriptor(error, "holder")?.value;
    return `Operation refused (${code})${code === "identity_unknown" && Array.isArray(known) && known.length <= 256 && known.every(v => typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v)) ? `; known names: ${known.join(", ")}` : ""}${code === "identity_in_use" && holderText(holder) ? `; held by ${holder}` : ""}`;
  }
  return "Operation failed; approval retained, explicitly enroll to retry";
}

function data(value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowed.length || keys.some(k => typeof k !== "string" || !allowed.includes(k))) return;
    const result: Record<string, unknown> = {};
    for (const k of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, k);
      if (!descriptor || !("value" in descriptor)) return;
      result[k] = descriptor.value;
    }
    return result;
  } catch { return; }
}
const clock = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + 60_000;
function failureDTO(value: unknown) {
  const d = data(value, ["operation", "code", "time"]);
  if (!d || typeof d.operation !== "string" || !operations.has(d.operation) || typeof d.code !== "string" || !codes.has(d.code) || !clock(d.time)) return;
  return { operation: d.operation, code: d.code, time: d.time };
}
function project(value: unknown, restored = false): RecordStatus | undefined {
  const d = data(value, fields);
  if (!d || typeof d.state !== "string" || !states.has(d.state) || typeof d.operation !== "string" || !operations.has(d.operation) || !clock(d.time)) return;
  if (d.sessionID !== undefined && (typeof d.sessionID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(d.sessionID))) return;
  if (d.name !== undefined && (typeof d.name !== "string" || !/^[a-z0-9_-]{1,32}$/.test(d.name))) return;
  if (d.ownership !== undefined && (typeof d.ownership !== "number" || !Number.isSafeInteger(d.ownership) || d.ownership <= 0)) return;
  if (d.code !== undefined && (typeof d.code !== "string" || !codes.has(d.code))) return;
  const failure = d.failure === undefined ? undefined : failureDTO(d.failure);
  if (d.failure !== undefined && !failure) return;
  if (typeof d.message !== "string" || d.message.length > 16384) return;
  const message = restored ? `Saved ${d.state} status${d.name ? ` for ${d.name}` : ""}${d.code ? ` (${d.code})` : ""}; approval is unchanged` : d.message;
  return { state: d.state, message, operation: d.operation, time: d.time, ...(typeof d.sessionID === "string" ? { sessionID: d.sessionID } : {}), ...(typeof d.name === "string" ? { name: d.name } : {}), ...(typeof d.ownership === "number" ? { ownership: d.ownership } : {}), ...(typeof d.code === "string" ? { code: d.code } : {}), ...(failure ? { failure } : {}) };
}

export function logFields(value: unknown) {
  const r = project(value, true);
  if (!r) return;
  return { category: "grayboard.subscriber", operation: r.operation, state: r.state, time: r.time,
    ...(r.sessionID ? { root: r.sessionID } : {}), ...(r.name ? { name: r.name } : {}),
    ...(r.ownership ? { ownership: r.ownership } : {}), ...(r.code ? { code: r.code } : {}) };
}

// Diagnostic storage never grants approval; a restored paused record only denies automatic restart.
export class Diagnostics {
  private records = new Map<string, RecordStatus>();
  private pending: Promise<void> = Promise.resolve();
  private failed = false;
  constructor(private readonly storage: Context["storage"], private readonly sink?: DiagnosticSink) {}
  async restore(acceptRoot?: (id: string) => Promise<boolean>) {
    try {
      const values = await this.storage.get(key);
      if (!Array.isArray(values)) return;
      const length = Object.getOwnPropertyDescriptor(values, "length")?.value;
      if (typeof length !== "number" || !Number.isSafeInteger(length)) return;
      for (let i = Math.max(0, length - 256); i < length; i++) {
        try {
          const r = project(Object.getOwnPropertyDescriptor(values, String(i))?.value, true);
          if (!r) continue;
          if (r.sessionID && !/^ses_[a-f0-9]{64}$/.test(r.sessionID) && !(acceptRoot && await acceptRoot(r.sessionID))) continue;
          this.records.set(r.sessionID ?? "background", r);
        } catch { continue; }
      }
    } catch {
      this.failed = true;
      this.record({ state: "degraded", message: "Diagnostic restore unavailable; approval is unchanged", operation: "restore", code: "operation_failed" });
    }
  }
  record(input: Omit<RecordStatus, "time">) {
    const d = data(input, fields);
    const previous = this.records.get(typeof d?.sessionID === "string" ? d.sessionID : "background");
    const time = Date.now();
    const failure = d?.code ? failureDTO({ operation: d.operation, code: d.code, time }) : failureDTO(previous?.failure);
    const record: RecordStatus = project({ ...d, ...(failure ? { failure } : {}), time }) ?? { state: "degraded", message: "Diagnostic record unavailable; approval is unchanged", operation: "delivery", time };
    this.records.delete(record.sessionID ?? "background");
    this.records.set(record.sessionID ?? "background", record);
    while (this.records.size > 256) this.records.delete(this.records.keys().next().value!);
    const snapshot = [...this.records.values()];
    const emitted = Object.freeze({ ...record, ...(record.failure ? { failure: Object.freeze({ ...record.failure }) } : {}) });
    this.pending = this.pending.then(async () => {
      let persisted = true;
      const retained = snapshot.map(saved => {
        const latest = this.records.get(saved.sessionID ?? "background");
        return latest?.failure?.operation === "diagnostic_emit" && latest.failure.time >= saved.time
          ? { ...saved, failure: { ...latest.failure } } : saved;
      });
      try { await this.storage.set(key, retained); } catch { this.failed = true; persisted = false; }
      try {
        if (!persisted) await this.sink?.(Object.freeze({ ...emitted, state: "degraded", message: "Diagnostic persistence unavailable; approval is unchanged", operation: "diagnostic_save", code: "operation_failed" }));
        await this.sink?.(emitted);
      }
      catch {
        this.failed = true;
        const time = Date.now();
        const current = this.records.get(record.sessionID ?? "background") ?? record;
        const emissionFailure = { operation: "diagnostic_emit", code: "operation_failed", time };
        const failure = current.state === "paused"
          ? { ...current, failure: emissionFailure }
          : { ...current, state: "degraded", message: "Diagnostic emission unavailable; approval is unchanged", operation: "diagnostic_emit", code: "operation_failed", time, failure: emissionFailure };
        this.records.set(record.sessionID ?? "background", failure);
        await this.storage.set(key, [...this.records.values()]);
      }
    }).catch(() => { this.failed = true; });
    return record;
  }
  status(): Status {
    const roots = structuredClone([...this.records.values()]);
    // An ended root's pause asks nothing of anyone; it stays listed but never speaks for the others.
    const live = roots.filter(r => !(r.state === "paused" && r.operation === "session_end"));
    const failed = live.find(r => r.state === "paused" || r.state === "degraded");
    const last = failed ?? live.at(-1) ?? roots.at(-1);
    return { state: this.failed ? "degraded" : last?.state ?? "unenrolled", message: this.failed ? "Diagnostic persistence unavailable; approval is unchanged" : last?.message ?? "Approve an active root; approval does not bind a name", ...(last?.sessionID ? { sessionID: last.sessionID } : {}), roots };
  }
  async flush() { await this.pending; return !this.failed; }
}
