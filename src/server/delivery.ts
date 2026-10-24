import { randomBytes } from "node:crypto";
import { refOf, type PendingRef } from "../core/boards.ts";
import type { AuthedUser } from "./auth.ts";
import { ApplicationError, type Application, type ApplicationSession, type DeliveryEvent, type IdentityInfo } from "./application.ts";

// Constructed by the authentication boundary, never from request identity fields.
export type DeliveryPrincipal = { authed: AuthedUser; grantId: string };
export type DeliveryLease = { capability: string; identity: IdentityInfo; expiresAt: number };
export type PendingDelivery = { id: string; actionable: boolean; event: DeliveryEvent };
export type DeliveryHooks = {
  changed?: () => void | Promise<void>;
  closed?: () => void | Promise<void>;
};
export type DeliveryOptions = {
  isAuthorized(principal: DeliveryPrincipal): boolean;
  ttlMs?: number;
  now?: () => number;
};
type Issued = { item: PendingDelivery; ref?: PendingRef; acked: boolean };
type Lease = {
  principal: DeliveryPrincipal;
  capability: string;
  expiresAt: number;
  session?: ApplicationSession;
  identity?: IdentityInfo;
  hooks: DeliveryHooks;
  issued: Map<string, Issued>;
  active: boolean;
};
const MAX_ISSUED = 1000;
function denied(): never {
  throw new ApplicationError("not_found", "delivery lease or item not found");
}
function notify(callback?: () => void | Promise<void>) {
  try { void Promise.resolve(callback?.()).catch(() => {}); } catch {}
}
function itemOf(event: DeliveryEvent): PendingDelivery {
  if (event.kind === "direct") return { id: `direct:${event.message.id}`, actionable: true, event };
  const item = event.item;
  return {
    id: item.kind === "push" ? `push:${item.post.id}` : `digest:${item.board}:${item.latest.id}`,
    actionable: item.kind === "push" && !item.deferred,
    event,
  };
}

export function createDelivery(application: Application, options: DeliveryOptions) {
  const ttl = options.ttlMs ?? 30_000;
  if (!Number.isFinite(ttl) || ttl < 1) throw new Error("invalid delivery TTL");
  const now = options.now ?? Date.now;
  const leases = new Map<string, Lease>();
  let stopped = false;
  function finish(lease: Lease) {
    if (!lease.active) return;
    lease.active = false;
    leases.delete(lease.capability);
    if (lease.session) application.close(lease.session);
    lease.issued.clear();
    notify(lease.hooks.closed);
  }
  function live(lease: Lease): boolean {
    let authorized = false;
    try { authorized = options.isAuthorized(lease.principal); } catch {}
    if (stopped || !lease.active || now() >= lease.expiresAt || !authorized) {
      finish(lease);
      return false;
    }
    // Includes disabled-user checks through the application's persistence boundary.
    if (lease.session) {
      try { application.revalidateSession(lease.session); } catch { finish(lease); return false; }
    }
    return true;
  }
  function get(principal: DeliveryPrincipal, capability: string): Lease {
    const lease = leases.get(capability);
    if (!lease || lease.principal.authed.user_id !== principal.authed.user_id ||
      lease.principal.authed.user_email !== principal.authed.user_email || lease.principal.grantId !== principal.grantId) denied();
    if (!live(lease)) denied();
    // Revalidate the caller too, even if its grant matches an older principal object.
    let authorized = false;
    try { authorized = options.isAuthorized(principal); } catch {}
    if (!authorized) { finish(lease); denied(); }
    return lease;
  }
  function describe(lease: Lease): DeliveryLease {
    return { capability: lease.capability, identity: lease.identity!, expiresAt: lease.expiresAt };
  }
  const service = {
    async open(principal: DeliveryPrincipal, identity: string, hooks: DeliveryHooks = {}): Promise<DeliveryLease> {
      const lease: Lease = {
        principal: { authed: { ...principal.authed }, grantId: principal.grantId },
        capability: randomBytes(32).toString("base64url"), expiresAt: now() + ttl,
        hooks, issued: new Map(), active: true,
      };
      if (!live(lease)) denied();
      leases.set(lease.capability, lease);
      try {
        const selected = await application.selectIdentity(lease.principal.authed, identity, {
          deliver: () => {
            if (lease.session) lease.session.inflight.clear();
            if (live(lease)) notify(lease.hooks.changed);
          },
          probe: async () => live(lease),
          closed: () => finish(lease),
        }, { push: true, alive: () => live(lease) });
        lease.session = selected.session;
        lease.identity = selected.info;
        if (!live(lease)) { application.close(selected.session); denied(); }
        return describe(lease);
      } catch (error) { finish(lease); throw error; }
    },
    renew(principal: DeliveryPrincipal, capability: string, hooks?: DeliveryHooks): DeliveryLease {
      const lease = get(principal, capability);
      if (hooks) lease.hooks = hooks;
      lease.expiresAt = now() + ttl;
      return describe(lease);
    },
    pending(principal: DeliveryPrincipal, capability: string, limit = 100): PendingDelivery[] {
      const lease = get(principal, capability);
      const items = application.pending(lease.session!, limit).map(itemOf);
      const unseen = items.filter(item => !lease.issued.has(item.id));
      // Retain receipt dedupe for the whole lease; backpressure instead of unsafe eviction.
      if (lease.issued.size + unseen.length > MAX_ISSUED) {
        throw new ApplicationError("bad_request", "delivery lease receipt capacity reached; release and reopen");
      }
      for (const item of unseen) lease.issued.set(item.id, {
        item: structuredClone(item), acked: false,
        ...(item.event.kind === "board" ? { ref: refOf(item.event.item) } : {}),
      });
      return items;
    },
    receipt(principal: DeliveryPrincipal, capability: string, ids: string[]): void {
      const lease = get(principal, capability);
      if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) denied();
      const records = ids.map(id => lease.issued.get(id) ?? denied());
      for (const record of records) {
        const event = record.item.event;
        if (event.kind === "board" && !application.canReceiveBoard(lease.session!, event.item.kind === "push" ? event.item.post.board : event.item.board)) denied();
      }
      const direct = records.filter(r => !r.acked && r.item.event.kind === "direct");
      if (direct.length) {
        const unread = application.pending(lease.session!, 100).filter(e => e.kind === "direct");
        const requested = new Set(direct.map(r => r.item.id));
        if (unread.length < direct.length || unread.slice(0, direct.length).some(e => !requested.has(itemOf(e).id))) denied();
      }
      // All validation completes before any durable cursor changes.
      application.receiptDirect(lease.session!, direct.map(r => {
        const e = r.item.event;
        return e.kind === "direct" ? e.message.id : denied();
      }));
      application.receiptBoards(lease.session!, records.filter(r => !r.acked && r.ref).map(r => r.ref!));
      for (const record of records) record.acked = true;
    },
    release(principal: DeliveryPrincipal, capability: string): void { finish(get(principal, capability)); },
    revalidate(): void { for (const lease of [...leases.values()]) live(lease); },
    close(): void {
      stopped = true;
      clearInterval(timer);
      for (const lease of [...leases.values()]) finish(lease);
    },
  };
  const timer = setInterval(() => service.revalidate(), Math.min(1000, Math.max(1, ttl / 3)));
  timer.unref();
  return service;
}
export type Delivery = ReturnType<typeof createDelivery>;
