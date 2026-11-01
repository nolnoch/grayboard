import { randomBytes } from "node:crypto";
import { refOf, type PendingRef } from "../core/boards.ts";
import { testPause, testPauseAsync } from "../shared/testpause.ts";
import { ApplicationError, type ApplicationSession, type DeliveryEvent, type IdentityInfo } from "./application.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import type { HostedSessions, SessionContext } from "./hosted.ts";
import type { HostedSession } from "./hosted-types.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";

export type DeliveryPrincipal = OAuthPrincipal;
export type DeliveryLease = { capability: string; identity: IdentityInfo; expiresAt: number; ownership: number; bind_gen: number };
// `address`: the alias a direct item was sent to, which the client checks against its hold set (#451); a DM to the session's own ID and a board item have none (canReceiveBoard checks boards).
export type PendingDelivery = { id: string; actionable: boolean; event: DeliveryEvent; ownership: number; bind_gen: number; address?: string };
export type DeliveryHooks = { changed?: () => void | Promise<void>; closed?: () => void | Promise<void> };
export type DeliveryOptions = { isAuthorized(principal: DeliveryPrincipal): boolean; now?: () => number };
type Issued = { item: PendingDelivery; ref?: PendingRef; acked: boolean };
type Lease = {
  principal: DeliveryPrincipal; capability: string; expiresAt: number; sessionId: string; ownership: number; generation: number;
  session: ApplicationSession; identity: IdentityInfo; hooks: DeliveryHooks; issued: Map<string, Issued>; acknowledged: Map<string, Issued>; openVersion: number; pendingOpens: Set<number>; acceptedVersion: number; cancelledCreator: boolean;
};
const notify = (operation: "delivery.changed" | "delivery.closed", fn?: () => void | Promise<void>) => { try { void Promise.resolve(fn?.()).catch(e => hostedFailure(operation, e)); } catch (e) { hostedFailure(operation, e); } };
class StaleCapability extends ApplicationError {
  constructor() { super("not_found", "no live delivery lease for this session; it was closed (expired or changed). Open a new one."); }
}
function itemOf(event: DeliveryEvent, lease: Lease): PendingDelivery {
  const stamp = { ownership: lease.ownership, bind_gen: lease.generation };
  if (event.kind === "direct") return { id: `direct:${event.message.id}`, actionable: true, event, ...stamp, ...(event.message.recipient === lease.sessionId ? {} : { address: event.message.recipient }) };
  const item = event.item;
  return { id: item.kind === "push" ? `push:${item.post.id}` : `digest:${item.board}:${item.latest.id}`, actionable: item.kind === "push" && !item.deferred, event, ...stamp };
}
export function createDelivery(hosted: HostedSessions, options: DeliveryOptions) {
  const application = hosted.application, store = application.repo.hosted;
  const ttl = hosted.leaseTtl, now = options.now ?? hosted.now;
  const leases = new Map<string, Lease>();
  const attempts = new WeakMap<DeliveryLease, { lease: Lease; version: number; created: boolean; hooks: DeliveryHooks }>();
  function opened(lease: Lease, created: boolean, hooks: DeliveryHooks) {
    const result = describe(lease);
    const version = ++lease.openVersion;
    lease.pendingOpens.add(version);
    attempts.set(result, { lease, version, created, hooks });
    return result;
  }
  let stopped = false;
  function finish(lease: Lease) {
    if (!leases.delete(lease.capability)) return;
    application.close(lease.session);
    lease.issued.clear(); lease.acknowledged.clear(); notify("delivery.closed", lease.hooks.closed);
  }
  function matches(lease: Lease, row?: HostedSession) {
    return !!row && row.session_id === lease.sessionId && row.ownership_id === lease.ownership && row.bind_gen === lease.generation &&
      row.grant_id === lease.principal.grantId && row.lease_deadline !== null && row.lease_deadline > now();
  }
  const unlisten = hosted.listen(() => {
    for (const lease of [...leases.values()]) if (!matches(lease, store.get(lease.sessionId))) finish(lease);
  });
  function stale(p: DeliveryPrincipal, context: SessionContext, capability: string): never {
    throw new StaleCapability();
  }
  function refused(p: DeliveryPrincipal, context: SessionContext, error: unknown): never {
    const id = "id" in context ? context.id : "no-context";
    if (error instanceof StaleCapability) hosted.audit(id, "hosted.stale_capability", {}, p);
    throw error;
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
    describe(p: DeliveryPrincipal, context: SessionContext, capability: string) { try { return describe(get(p, context, capability)); } catch (error) { return refused(p, context, error); } },
    async open(p: DeliveryPrincipal, context: SessionContext, hooks: DeliveryHooks = {}): Promise<DeliveryLease> {
      let previous: Lease | undefined;
      return hosted.owning(p, context, row => {
        if (!application.hostedHolds(row.session_id).length) throw new ApplicationError("unbound", "unbound; bind a name before opening delivery");
        previous = [...leases.values()].find(l => l.sessionId === row.session_id);
        if (previous && matches(previous, row)) return previous;
        if (leases.size >= 256 || [...leases.values()].filter(l => l.principal.authed.user_id === p.authed.user_id).length >= 32) throw new ApplicationError("bad_request", "delivery lease capacity reached");
        const expiresAt = now() + ttl;
        store.update({ ...row, lease_deadline: expiresAt, last_seen_at: now() });
        hosted.audit(row.session_id, "hosted.lease_opened", { ownership: row.ownership_id, bind_gen: row.bind_gen, grant: p.grantId, reopened: row.lease_deadline !== null });
        return { row, expiresAt };
      }, result => {
        if ("capability" in result) return opened(result, false, hooks);
        if (previous) finish(previous);
        const { row, expiresAt } = result;
        let lease!: Lease;
        const selected = application.hostedSession(p.authed, row.session_id, application.hostedHolds(row.session_id), null, row.place, {
          deliver() { if (lease && matches(lease, store.get(lease.sessionId))) { lease.session.inflight.clear(); notify("delivery.changed", lease.hooks.changed); } },
          probe: async () => true,
          closed() { if (lease) finish(lease); },
        }, false, true);
        lease = { principal: p, capability: randomBytes(32).toString("base64url"), expiresAt, sessionId: row.session_id,
          ownership: row.ownership_id, generation: row.bind_gen, session: selected.session, identity: selected.info, hooks, issued: new Map(), acknowledged: new Map(), openVersion: 0, pendingOpens: new Set(), acceptedVersion: 0, cancelledCreator: false };
        leases.set(lease.capability, lease);
        return opened(lease, true, hooks);
      });
    },
    accept(result: DeliveryLease) {
      const attempt = attempts.get(result);
      if (attempt) {
        attempt.lease.pendingOpens.delete(attempt.version);
        if (leases.get(result.capability) === attempt.lease && attempt.version > attempt.lease.acceptedVersion) {
          attempt.lease.acceptedVersion = attempt.version;
          attempt.lease.hooks = attempt.hooks;
        }
      }
      attempts.delete(result);
    },
    async renew(p: DeliveryPrincipal, context: SessionContext, capability: string, hooks?: DeliveryHooks) {
      return hosted.control(p, context, false, row => {
        const { lease, deadline } = store.atomic(() => {
          const fresh = store.get(row.session_id);
          const lease = get(p, context, capability, fresh), deadline = now() + ttl;
          if (!fresh || fresh.root_session_id) stale(p, context, capability);
          store.update({ ...fresh, lease_deadline: deadline, last_seen_at: now() });
          return { lease, deadline };
        });
        lease.expiresAt = deadline;
        if (hooks) lease.hooks = hooks;
        return describe(lease);
      }).catch(error => refused(p, context, error));
    },
    async pending(p: DeliveryPrincipal, context: SessionContext, capability: string, limit = 100): Promise<PendingDelivery[]> {
      return hosted.control(p, context, false, async row => {
        const lease = get(p, context, capability, row);
        await testPauseAsync("hosted:pending:in-gate");
        get(p, context, capability);
        const items = application.pending(lease.session, limit).map(event => itemOf(event, lease));
        const unseen = items.filter(item => !lease.issued.has(item.id));
        if (lease.issued.size + unseen.length > 1000) throw new ApplicationError("receipt_capacity", "delivery lease receipt capacity reached; release and reopen");
        for (const item of unseen) lease.issued.set(item.id, { item: structuredClone(item), acked: false, ...(item.event.kind === "board" ? { ref: refOf(item.event.item) } : {}) });
        return items;
      }).catch(error => refused(p, context, error));
    },
    async receipt(p: DeliveryPrincipal, context: SessionContext, capability: string, ids: string[]): Promise<void> {
      return hosted.control(p, context, false, async () => {
        await testPauseAsync("hosted:receipt:before-txn");
        const records = store.atomic(() => {
          testPause("hosted:receipt:in-txn");
          const row = "id" in context ? store.get(context.id) : undefined;
          const lease = get(p, context, capability, row);
          if (!row || row.root_session_id) stale(p, context, capability);
          if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) stale(p, context, capability);
          const records = ids.map(id => lease.issued.get(id) ?? lease.acknowledged.get(id) ?? stale(p, context, capability));
          for (const r of records) {
            if (r.item.ownership !== row.ownership_id || r.item.bind_gen !== row.bind_gen || (r.item.address !== undefined && !lease.session.addresses.includes(r.item.address))) stale(p, context, capability);
            if (r.item.event.kind === "board" && !application.canReceiveBoard(lease.session, r.item.event.item.kind === "push" ? r.item.event.item.post.board : r.item.event.item.board)) stale(p, context, capability);
          }
          const direct = records.filter(r => !r.acked && r.item.event.kind === "direct");
          if (direct.length) {
            const unread = application.pending(lease.session, 100).filter(e => e.kind === "direct");
            const requested = new Set(direct.map(r => r.item.id));
            if (unread.length < direct.length || unread.slice(0, direct.length).some(e => !requested.has(itemOf(e, lease).id))) stale(p, context, capability);
          }
          application.receiptDirect(lease.session, direct.map(r => r.item.event.kind === "direct" ? r.item.event.message.id : stale(p, context, capability)));
          application.receiptBoards(lease.session, records.filter(r => !r.acked && r.ref).map(r => r.ref!));
          return { lease, records };
        });
        for (const r of records.records) {
          r.acked = true;
          records.lease.issued.delete(r.item.id);
          records.lease.acknowledged.set(r.item.id, r);
        }
        while (records.lease.acknowledged.size > 1000) records.lease.acknowledged.delete(records.lease.acknowledged.keys().next().value!);
      }).catch(error => refused(p, context, error));
    },
    async release(p: DeliveryPrincipal, context: SessionContext, capability: string) {
      return hosted.control(p, context, true, row => {
        store.atomic(() => {
          get(p, context, capability, store.get(row.session_id));
          store.end(row.session_id, "closed", now());
        });
        hosted.reconcile();
      }).catch(error => refused(p, context, error));
    },
    async cancel(result: DeliveryLease) {
      const attempt = attempts.get(result);
      attempts.delete(result);
      if (!attempt) return;
      const { lease, version } = attempt;
      lease.pendingOpens.delete(version);
      if (attempt.created) lease.cancelledCreator = true;
      const capability = result.capability;
      await hosted.gate(lease.sessionId).bind(async () => {
        if (leases.get(capability) !== lease || !lease.cancelledCreator || lease.pendingOpens.size || lease.acceptedVersion) return;
        store.atomic(() => {
          if (matches(lease, store.get(lease.sessionId))) store.end(lease.sessionId, "closed", now());
        });
        hosted.sweep();
        finish(lease);
      });
    },
    revalidate() { hosted.sweep(); },
    close() {
      stopped = true; unlisten();
      // The capability is dropped, but the lease row stays; a restart credits it with the downtime (#423).
      for (const lease of [...leases.values()]) { hosted.audit(lease.sessionId, "hosted.lease_detached", { reason: "shutdown" }, lease.principal); finish(lease); }
    },
  };
  return service;
}
export type Delivery = ReturnType<typeof createDelivery>;
