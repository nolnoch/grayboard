import type { Context } from "@opencode/plugin/promise/plugin";
import { SubscriberError } from "./wire.js";

export type RecordStatus = { state: string; message: string; sessionID?: string; time: number; name?: string; ownership?: number; operation: string; code?: string; failure?: { operation: string; code: string; time: number } };
export type Status = { state: string; message: string; sessionID?: string; roots: RecordStatus[] };
export type DiagnosticSink = (record: Readonly<RecordStatus>) => void;
export class DeliveryStopped extends Error {
  constructor(readonly item?: string) { super("Delivery retry budget exhausted"); }
}
const key = "diagnostics:v1";
const fields = ["state", "message", "sessionID", "time", "name", "ownership", "operation", "code", "failure"];
const states = new Set(["approved", "active", "paused", "unbound", "unenrolled", "retrying", "rebinding", "degraded"]);
const codes = new Set(["identity_unknown", "identity_in_use", "not_found", "unbound", "refused", "internal_error", "bad_request", "unauthenticated", "forbidden", "rate_limited", "receipt_capacity", "invalid_response"]);
export function failureCode(error: unknown): string {
  if (error instanceof DeliveryStopped) return "retry_exhausted";
  if (error instanceof SubscriberError) {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof code === "string" && codes.has(code)) return code;
  }
  return "operation_failed";
}
export function failureMessage(error: unknown): string {
  if (error instanceof DeliveryStopped) return `Retry limit reached${error.item ? ` for ${error.item}; item remains unreceipted` : " before inbox progress"}; explicitly enroll again`;
  if (error instanceof SubscriberError) {
    const code = failureCode(error);
    const known = Object.getOwnPropertyDescriptor(error, "known")?.value;
    return `Operation refused (${code})${code === "identity_unknown" && Array.isArray(known) && known.length <= 256 && known.every(v => typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v)) ? `; known names: ${known.join(", ")}` : ""}`;
  }
  return "Operation failed; approval retained, explicitly enroll to retry";
}

// Diagnostic storage is never read by approval or ownership checks.
export class Diagnostics {
  private records = new Map<string, RecordStatus>();
  private pending: Promise<void> = Promise.resolve();
  private failed = false;
  constructor(private readonly storage: Context["storage"], private readonly sink?: DiagnosticSink) {}
  async restore() {
    const values = await this.storage.get(key);
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-256)) {
      if (!value || typeof value !== "object" || Object.keys(value).some(k => !fields.includes(k))) continue;
      const r = value as RecordStatus;
      if (typeof r.sessionID !== "string" || !states.has(r.state) || typeof r.message !== "string" || r.message.length > 16384 || typeof r.operation !== "string" || !Number.isFinite(r.time)) continue;
      if (r.name !== undefined && !/^[a-z0-9_-]{1,32}$/.test(r.name) || r.ownership !== undefined && !Number.isSafeInteger(r.ownership)) continue;
      this.records.set(r.sessionID, structuredClone(r));
    }
  }
  record(input: Omit<RecordStatus, "time">) {
    const previous = this.records.get(input.sessionID ?? "background");
    const time = Date.now();
    const failure = input.code ? { operation: input.operation, code: input.code, time } : previous?.failure;
    const record = { ...input, ...(failure ? { failure } : {}), time };
    this.records.delete(record.sessionID ?? "background");
    this.records.set(record.sessionID ?? "background", record);
    while (this.records.size > 256) this.records.delete(this.records.keys().next().value!);
    try { this.sink?.(Object.freeze({ ...record })); } catch { this.failed = true; }
    const snapshot = [...this.records.values()];
    this.pending = this.pending.then(() => this.storage.set(key, snapshot)).catch(() => { this.failed = true; });
    return record;
  }
  status(): Status {
    const roots = structuredClone([...this.records.values()]);
    const failed = roots.find(r => r.state === "paused" || r.state === "degraded");
    const last = failed ?? roots.at(-1);
    return { state: this.failed ? "degraded" : last?.state ?? "unenrolled", message: this.failed ? "Diagnostic persistence unavailable; approval is unchanged" : last?.message ?? "Approve an active root; approval does not bind a name", ...(last?.sessionID ? { sessionID: last.sessionID } : {}), roots };
  }
  async flush() { await this.pending; return !this.failed; }
}
