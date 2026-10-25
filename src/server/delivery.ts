import { randomBytes } from "node:crypto";
import { refOf, type PendingRef } from "../core/boards.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import { ApplicationError, type ApplicationSession, type DeliveryEvent, type IdentityInfo } from "./application.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import type { HostedSessions, SessionContext } from "./hosted.ts";
import type { HostedSession } from "./hosted-types.ts";

export type DeliveryPrincipal = OAuthPrincipal;
export type DeliveryLease = { capability: string; identity: IdentityInfo; expiresAt: number; ownership: number; bind_gen: number };
export type PendingDelivery = { id: string; actionable: boolean; event: DeliveryEvent; ownership: number; bind_gen: number; name: string };
export type DeliveryHooks = { changed?: () => void | Promise<void>; closed?: () => void | Promise<void> };
export type DeliveryOptions = { isAuthorized(principal: DeliveryPrincipal): boolean; ttlMs?: number; now?: () => number };
type Issued = { item: PendingDelivery; ref?: PendingRef; acked: boolean };
type Lease = {
  principal: DeliveryPrincipal; capability: string; expiresAt: number; sessionId: string; ownership: number; generation: number; name: string;
  session: ApplicationSession; identity: IdentityInfo; hooks: DeliveryHooks; issued: Map<string, Issued>;
};
const notify = (fn?: () => void | Promise<void>) => { try { void Promise.resolve(fn?.()).catch(() => {}); } catch {} };
function itemOf(event: DeliveryEvent, lease: Lease): PendingDelivery {
  const stamp = { ownership: lease.ownership, bind_gen: lease.generation, name: lease.name };
  if (event.kind === "direct") return { id: `direct:${event.message.id}`, actionable: true, event, ...stamp };
  const item = event.item;
  return { id: item.kind === "push" ? `push:${item.post.id}` : `digest:${item.board}:${item.latest.id}`, actionable: item.kind === "push" && !item.deferred, event, ...stamp };
}
export function createDelivery(hosted: HostedSessions, options: DeliveryOptions) {
  const application = hosted.application, store = application.repo.hosted;
  const ttl = options.ttlMs ?? 30_000, now = options.now ?? hosted.now;
  if (!Number.isFinite(ttl) || ttl < 1) throw new Error("invalid delivery TTL");
  const leases = new Map<string, Lease>();
  let stopped = false;
  function finish(lease: Lease) {
    if (!leases.delete(lease.capability)) return;
    application.close(lease.session);
    lease.issued.clear(); notify(lease.hooks.closed);
  }
  function matches(lease: Lease, row?: HostedSession) {
    return !!row && row.session_id === lease.sessionId && row.ownership_id === lease.ownership && row.bind_gen === lease.generation &&
      row.grant_id === lease.principal.grantId && row.name === lease.name && row.lease_deadline !== null && row.lease_deadline > now();
  }
  const unlisten = hosted.listen(() => {
    for (const lease of [...leases.values()]) if (!matches(lease, store.get(lease.sessionId))) finish(lease);
  });
  function stale(p: DeliveryPrincipal, context: SessionContext, capability: string): never {
    const id = "id" in context ? context.id : "no-context";
    hosted.audit(id, "hosted.stale_capability", { capability: capability.slice(0, 8), grant: p.grantId });
    throw new ApplicationError("not_found", `no live delivery lease ${capability.slice(0, 8)} for this session; it was closed (expired or changed). Open a new one.`);
  }
  function get(p: DeliveryPrincipal, context: SessionContext, capability: string, row?: HostedSession) {
    const lease = leases.get(capability);
    if (stopped || !lease || !("id" in context) || context.id !== lease.sessionId ||
      p.authed.user_id !== lease.principal.authed.user_id || p.clientId !== lease.principal.clientId || p.grantId !== lease.principal.grantId ||
      !matches(lease, row ?? store.get(lease.sessionId)) || !options.isAuthorized(p)) return stale(p, context, capability);
    return lease;
  }
  const describe = (l: Lease): DeliveryLease => ({ capability: l.capability, identity: structuredClone(l.identity), expiresAt: l.expiresAt, ownership: l.ownership, bind_gen: l.generation });
  const service = {
    get activeLeaseCount() { return leases.size; },
    describe(p: DeliveryPrincipal, context: SessionContext, capability: string) { return describe(get(p, context, capability)); },
    async open(p: DeliveryPrincipal, context: SessionContext, hooks: DeliveryHooks = {}): Promise<DeliveryLease> {
      let previous: Lease | undefined;
      return hosted.owning(p, context, row => {
        if (!row.name) throw new ApplicationError("unbound", "unbound; bind a name before opening delivery");
        previous = [...leases.values()].find(l => l.sessionId === row.session_id);
        if (previous && matches(previous, row)) return previous;
        if (leases.size >= 256 || [...leases.values()].filter(l => l.principal.authed.user_id === p.authed.user_id).length >= 32) throw new ApplicationError("bad_request", "delivery lease capacity reached");
        const expiresAt = now() + ttl;
        store.update({ ...row, lease_deadline: expiresAt, last_seen_at: now() });
        hosted.audit(row.session_id, "hosted.lease_opened", { ownership: row.ownership_id, bind_gen: row.bind_gen, grant: p.grantId, reopened: row.lease_deadline !== null });
        return { row, expiresAt };
      }, result => {
        if ("capability" in result) { result.hooks = hooks; return describe(result); }
        if (previous) finish(previous);
        const { row, expiresAt } = result;
        let lease!: Lease;
        const selected = application.hostedSession(p.authed, row.session_id, row.name, row.place, {
          deliver() { if (lease && matches(lease, store.get(lease.sessionId))) { lease.session.inflight.clear(); notify(lease.hooks.changed); } },
          probe: async () => true,
          closed() { if (lease) finish(lease); },
        }, false, true);
        lease = { principal: p, capability: randomBytes(32).toString("base64url"), expiresAt, sessionId: row.session_id,
          ownership: row.ownership_id, generation: row.bind_gen, name: row.name!, session: selected.session, identity: selected.info, hooks, issued: new Map() };
        leases.set(lease.capability, lease);
        return describe(lease);
      });
    },
    async renew(p: DeliveryPrincipal, context: SessionContext, capability: string, hooks?: DeliveryHooks) {
      return hosted.control(p, context, true, row => {
        const lease = get(p, context, capability, row), deadline = now() + ttl;
        store.atomic(() => store.update({ ...row, lease_deadline: deadline, last_seen_at: now() }));
        lease.expiresAt = deadline;
        if (hooks) lease.hooks = hooks;
        return describe(lease);
      });
    },
    async pending(p: DeliveryPrincipal, context: SessionContext, capability: string, limit = 100): Promise<PendingDelivery[]> {
      return hosted.control(p, context, false, async row => {
        const lease = get(p, context, capability, row);
        await testPauseAsync("hosted:pending:in-gate");
        get(p, context, capability);
        const items = application.pending(lease.session, limit).map(event => itemOf(event, lease));
        const unseen = items.filter(item => !lease.issued.has(item.id));
        if (lease.issued.size + unseen.length > 1000) throw new ApplicationError("bad_request", "delivery lease receipt capacity reached; release and reopen");
        for (const item of unseen) lease.issued.set(item.id, { item: structuredClone(item), acked: false, ...(item.event.kind === "board" ? { ref: refOf(item.event.item) } : {}) });
        return items;
      });
    },
    async receipt(p: DeliveryPrincipal, context: SessionContext, capability: string, ids: string[]): Promise<void> {
      return hosted.control(p, context, false, row => {
        const lease = get(p, context, capability, row);
        if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) stale(p, context, capability);
        const records = ids.map(id => lease.issued.get(id) ?? stale(p, context, capability));
        for (const r of records) {
          if (r.item.ownership !== row.ownership_id || r.item.bind_gen !== row.bind_gen || r.item.name !== row.name) stale(p, context, capability);
          if (r.item.event.kind === "board" && !application.canReceiveBoard(lease.session, r.item.event.item.kind === "push" ? r.item.event.item.post.board : r.item.event.item.board)) stale(p, context, capability);
        }
        const direct = records.filter(r => !r.acked && r.item.event.kind === "direct");
        if (direct.length) {
          const unread = application.pending(lease.session, 100).filter(e => e.kind === "direct");
          const requested = new Set(direct.map(r => r.item.id));
          if (unread.length < direct.length || unread.slice(0, direct.length).some(e => !requested.has(itemOf(e, lease).id))) stale(p, context, capability);
        }
        store.atomic(() => {
          application.receiptDirect(lease.session, direct.map(r => r.item.event.kind === "direct" ? r.item.event.message.id : stale(p, context, capability)));
          application.receiptBoards(lease.session, records.filter(r => !r.acked && r.ref).map(r => r.ref!));
        });
        for (const r of records) r.acked = true;
      });
    },
    async release(p: DeliveryPrincipal, context: SessionContext, capability: string) {
      return hosted.control(p, context, true, row => {
        get(p, context, capability, row);
        hosted.release(row.session_id, "closed");
      });
    },
    async cancel(capability: string) {
      const lease = leases.get(capability);
      if (!lease) return;
      await hosted.gate(lease.sessionId).bind(async () => {
        if (leases.get(capability) !== lease) return;
        if (matches(lease, store.get(lease.sessionId))) hosted.release(lease.sessionId, "closed");
        finish(lease);
      });
    },
    revalidate() { hosted.sweep(); },
    close() {
      stopped = true; unlisten();
      for (const lease of [...leases.values()]) { hosted.audit(lease.sessionId, "hosted.lease_closed", { reason: "shutdown" }); finish(lease); }
    },
  };
  return service;
}
export type Delivery = ReturnType<typeof createDelivery>;
