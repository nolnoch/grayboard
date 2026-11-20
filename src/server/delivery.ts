import { randomBytes } from "node:crypto";
import { DEFAULT_HOSTED_CAPS, type HostedCaps } from "./config.ts";
import { refOf, type PendingRef } from "../core/boards.ts";
import { testPause, testPauseAsync } from "../shared/testpause.ts";
import { ApplicationError, type ApplicationSession, type DeliveryEvent, type IdentityInfo } from "./application.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import type { HostedSessions, SessionContext } from "./hosted.ts";
import type { HostedSession } from "./hosted-types.ts";
import type { Read } from "./store/tx.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";
import { countRefusal } from "./metrics.ts";

export type DeliveryPrincipal = OAuthPrincipal;
export type DeliveryLease = { capability: string; identity: IdentityInfo; expiresAt: number; ownership: number; bind_gen: number };
// `address`: the alias a direct item was sent to, which the client checks against its hold set (#451); a DM to the session's own ID and a board item have none (boardsVisible checks boards).
export type PendingDelivery = { id: string; actionable: boolean; event: DeliveryEvent; ownership: number; bind_gen: number; address?: string };
// `context: false`: the host can't show an item without starting a turn (Claude Code), so non-waking items wait (#854).
export type DeliveryOpenOptions = { context?: boolean };
export type DeliveryHooks = { changed?: () => void | Promise<void>; closed?: () => void | Promise<void> };
// `r`: the body's Tx when the check runs inside one, so it sees that body's own revokes; else the pool.
export type DeliveryOptions = { isAuthorized(principal: DeliveryPrincipal, r?: Read): boolean | Promise<boolean>; now?: () => number; caps?: HostedCaps["leases"] };
type Issued = { item: PendingDelivery; ref?: PendingRef };
// What a retried receipt of an acknowledged id re-checks, without the item's body (#805).
type Acked = { ownership: number; bind_gen: number; address?: string; board?: string };
// A lost receipt's retry re-sends one call's ids (at most 100; hosted-core receipts one per call): twice that per lease.
const ACKED_HISTORY = 200;
const boardOf = (item: PendingDelivery) => item.event.kind === "board" ? (item.event.item.kind === "push" ? item.event.item.post.board : item.event.item.board) : undefined;
type Lease = {
  principal: DeliveryPrincipal; capability: string; expiresAt: number; sessionId: string; ownership: number; generation: number;
  session: ApplicationSession; identity: IdentityInfo; hooks: DeliveryHooks; issued: Map<string, Issued>; acknowledged: Map<string, Acked>; openVersion: number; pendingOpens: Set<number>; acceptedVersion: number; cancelledCreator: boolean;
  // `context: false`: a host that starts a turn for every item (#854; `drained` below).
  context: boolean;
  // The session's row as the last commit seen left it (#807 P3 A7h2): open's, then each notice's or full pass's.
  // The synchronous checks (`deliver()`, `finish`'s drained key) judge it; a check that admits work reads its own.
  row: HostedSession | undefined;
};
const notify = (operation: "delivery.changed" | "delivery.closed", fn?: () => void | Promise<void>) => { try { void Promise.resolve(fn?.()).catch(e => hostedFailure(operation, e)); } catch (e) { hostedFailure(operation, e); } };
class StaleCapability extends ApplicationError {
  constructor() { super("not_found", "no live delivery lease for this session; it was closed (expired or changed). Open a new one."); }
}
function itemOf(event: DeliveryEvent, lease: Lease): PendingDelivery {
  const stamp = { ownership: lease.ownership, bind_gen: lease.generation };
  // An ungranted item (another user's, no msg.wake grant: security audit F-03) is shown, never acted on.
  if (event.kind === "direct") return { id: `direct:${event.message.id}`, actionable: !event.message.ungranted, event, ...stamp, ...(event.message.recipient === lease.sessionId ? {} : { address: event.message.recipient }) };
  const item = event.item;
  return { id: item.kind === "push" ? `push:${item.post.id}` : `digest:${item.board}:${item.latest.id}`, actionable: item.kind === "push" && !item.deferred && !item.post.ungranted, event, ...stamp };
}
export function createDelivery(hosted: HostedSessions, options: DeliveryOptions) {
  const application = hosted.application, store = application.repo.hosted, pool = application.repo.read;
  const ttl = hosted.leaseTtl, now = options.now ?? hosted.now, caps = options.caps ?? DEFAULT_HOSTED_CAPS.leases;
  const leases = new Map<string, Lease>();
  // A session holds at most one lease (a reopen finishes the previous first): looked up and counted without a
  // scan (#805).
  const bySession = new Map<string, Lease>(), perUser = new Map<number, number>();
  function track(lease: Lease) {
    leases.set(lease.capability, lease); bySession.set(lease.sessionId, lease);
    const user = lease.principal.authed.user_id;
    perUser.set(user, (perUser.get(user) ?? 0) + 1);
  }
  const attempts = new WeakMap<DeliveryLease, { lease: Lease; version: number; created: boolean; hooks: DeliveryHooks }>();
  function opened(lease: Lease, created: boolean, hooks: DeliveryHooks) {
    const result = describe(lease);
    const version = ++lease.openVersion;
    lease.pendingOpens.add(version);
    attempts.set(result, { lease, version, created, hooks });
    return result;
  }
  // Security audit F-03 (#854): the `session:ownership` pairs whose first drain a host admitted (a receipt, or
  // a pull with nothing to give). Kept past a lease, so a lease replaced within one ownership (a bind, an unbind,
  // a revoked alias, which another user can cause) never drains withheld items again; dropped with the ownership.
  // In memory: a server restart drains once more, which no sender can cause.
  const drained = new Set<string>();
  const drainKey = (lease: Lease) => `${lease.sessionId}:${lease.ownership}`;
  let stopped = false;
  function finish(lease: Lease) {
    if (!leases.delete(lease.capability)) return;
    if (lease.row?.ownership_id !== lease.ownership) drained.delete(drainKey(lease));
    if (bySession.get(lease.sessionId) === lease) bySession.delete(lease.sessionId);
    const user = lease.principal.authed.user_id, n = (perUser.get(user) ?? 1) - 1;
    if (n) perUser.set(user, n); else perUser.delete(user);
    application.close(lease.session);
    lease.issued.clear(); lease.acknowledged.clear(); notify("delivery.closed", lease.hooks.closed);
  }
  function matches(lease: Lease, row?: HostedSession) {
    return !!row && row.session_id === lease.sessionId && row.ownership_id === lease.ownership && row.bind_gen === lease.generation &&
      row.grant_id === lease.principal.grantId && row.lease_deadline !== null && row.lease_deadline > now();
  }
  // A lease's row from a commit: kept, and the lease finished if it no longer matches.
  function seen(lease: Lease, row: HostedSession | undefined) {
    lease.row = row;
    if (!matches(lease, row)) finish(lease);
  }
  // `changed`: the one row a commit changed (#399), so only its lease is checked, against `row` as the commit left
  // it. A notice without the row (null, or one without facts) leaves the leases to the full pass it requested,
  // which reads their rows on its Tx and hands them over before the queue's next body (#807 P3 A7h2). Meanwhile
  // `deliver()` may wake a lease that pass will finish; the pull it causes checks a row of its own and is refused.
  const unlisten = hosted.listen((changed, row) => {
    if (changed === null || row === undefined) return;
    const lease = bySession.get(changed);
    if (lease) seen(lease, row ?? undefined);
  });
  const unwatch = hosted.watchRows({
    ids: () => bySession.keys(),
    apply(rows) { for (const [id, row] of rows) { const lease = bySession.get(id); if (lease) seen(lease, row); } },
  });
  function stale(p: DeliveryPrincipal, context: SessionContext, capability: string): never {
    throw new StaleCapability();
  }
  function refused(p: DeliveryPrincipal, context: SessionContext, error: unknown): never {
    const id = "id" in context ? context.id : "no-context";
    if (error instanceof StaleCapability) hosted.auditAs(pool, id, "hosted.stale_capability", {}, p);
    throw error;
  }
  // The lease for `capability`, without the token check: only for a caller that checked p's token this turn, with no
  // await since (#853), so synchronous. `row`: context's row, read by the caller (on its Tx inside a body); none
  // refuses.
  function getChecked(p: DeliveryPrincipal, context: SessionContext, capability: string, row: HostedSession | undefined) {
    const lease = leases.get(capability);
    if (stopped || !lease || !("id" in context) || context.id !== lease.sessionId ||
      p.authed.user_id !== lease.principal.authed.user_id || p.clientId !== lease.principal.clientId || p.grantId !== lease.principal.grantId ||
      !matches(lease, row)) return stale(p, context, capability);
    return lease;
  }
  // getChecked, then p's token checked on `r` (#807 P3 A7d2b). A lease finished while the check awaited (a commit's
  // hosted.listen, a shutdown) is refused, never returned.
  async function get(p: DeliveryPrincipal, context: SessionContext, capability: string, row: HostedSession | undefined, r: Read = pool) {
    const lease = getChecked(p, context, capability, row);
    if (!await options.isAuthorized(p, r) || stopped || leases.get(capability) !== lease) return stale(p, context, capability);
    return lease;
  }
  const describe = (l: Lease): DeliveryLease => ({ capability: l.capability, identity: structuredClone(l.identity), expiresAt: l.expiresAt, ownership: l.ownership, bind_gen: l.generation });
  const service = {
    get activeLeaseCount() { return leases.size; },
    // `checked`: the caller's row for context.id, read after it authorized p with no await since (#853). Required: a
    // caller without one has no synchronous way to check the token (#807 P3 A7d2b).
    describe(p: DeliveryPrincipal, context: SessionContext, capability: string, checked: { row: HostedSession | undefined }) {
      try { return describe(getChecked(p, context, capability, checked.row)); } catch (error) { return refused(p, context, error); }
    },
    // `describe`'s check without its copy of the identity: the per-request lease check reads one field (#912).
    identityFull(p: DeliveryPrincipal, context: SessionContext, capability: string, checked: { row: HostedSession | undefined }): string {
      try { return getChecked(p, context, capability, checked.row).identity.identity_full; } catch (error) { return refused(p, context, error); }
    },
    async open(p: DeliveryPrincipal, context: SessionContext, hooks: DeliveryHooks = {}, openOptions: DeliveryOpenOptions = {}): Promise<DeliveryLease> {
      let previous: Lease | undefined;
      return hosted.owning(p, context, async (row, _defer, tx) => {
        const holds = await application.hostedHolds(tx, row.session_id);
        if (!holds.length) throw new ApplicationError("unbound", "unbound; bind a name before opening delivery");
        await hosted.seeLost(tx, p, row);
        const reuse = () => {
          previous = bySession.get(row.session_id);
          if (!previous || !matches(previous, row)) return undefined;
          previous.context = openOptions.context ?? true;
          return previous;
        };
        const kept = reuse();
        if (kept) return kept;
        // The session's facts on this transaction (#807 P3 A7g1), so `committed` builds it without reading. The
        // lease map is read again after the await: a close can change it meanwhile (D4's exception).
        const facts = await application.hostedBuildFacts(tx, p.authed, row.session_id, { holds, writesAs: null, suggested: row.suggested, root: null });
        const again = reuse();
        if (again) return again;
        // A lease this open replaces (another grant's) frees its slot here, not after the check; a
        // session is one user's, so that slot is this user's.
        const replaced = previous ? 1 : 0;
        // A service's tier (#270 D4) in place of the per-user cap, never above the global one.
        const mine = p.authed.kind === "service" ? Math.min(caps.perService ?? caps.perUser, caps.global) : caps.perUser;
        if (leases.size - replaced >= caps.global || (perUser.get(p.authed.user_id) ?? 0) - replaced >= mine) { countRefusal("delivery_lease"); throw new ApplicationError("bad_request", "delivery lease capacity reached"); }
        const expiresAt = now() + ttl;
        const opened = { ...row, lease_deadline: expiresAt, last_seen_at: now() };
        // The lease's columns only (#807 P3 C8 decision 2); attach locked the row.
        await store.update(tx, row.session_id, { lease_deadline: opened.lease_deadline, last_seen_at: opened.last_seen_at });
        await hosted.audit(tx, row.session_id, "hosted.lease_opened", { ownership: row.ownership_id, bind_gen: row.bind_gen, grant: p.grantId, reopened: row.lease_deadline !== null, ...(openOptions.context === false ? { context: false } : {}) });
        return { row: opened, expiresAt, holds, facts };
      }, result => {
        // The body awaits after its reads (seeLost, the row's update, the audit): a close that ran meanwhile finished
        // every lease, and one tracked now would outlive it with nothing to finish it (#1122). Its row stays, as close
        // leaves every lease's row.
        if (stopped) stale(p, context, "capability" in result ? result.capability : "");
        if ("capability" in result) return opened(result, false, hooks);
        if (previous) finish(previous);
        const { row, expiresAt, holds, facts } = result;
        let lease!: Lease;
        const selected = application.hostedBuild(p.authed, row.session_id, holds, null, row, {
          deliver() { if (lease && matches(lease, lease.row)) { lease.session.inflight.clear(); notify("delivery.changed", lease.hooks.changed); } },
          closed() { if (lease) finish(lease); },
        }, facts, true);
        lease = { principal: p, capability: randomBytes(32).toString("base64url"), expiresAt, sessionId: row.session_id,
          ownership: row.ownership_id, generation: row.bind_gen, session: selected.session, identity: selected.info, hooks, issued: new Map(), acknowledged: new Map(), openVersion: 0, pendingOpens: new Set(), acceptedVersion: 0, cancelledCreator: false,
          context: openOptions.context ?? true, row };
        track(lease);
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
      return hosted.control(p, context, false, async row => {
        const { lease } = await store.write(async tx => {
          // Locked before it is read (#807 P3 C8 R2): a bind's generation bump committed meanwhile is the row judged here,
          // and the update writes the lease's columns only.
          const fresh = await store.lock(tx, row.session_id);
          const lease = await get(p, context, capability, fresh, tx), deadline = now() + ttl;
          if (!fresh || fresh.root_session_id) stale(p, context, capability);
          await store.update(tx, fresh.session_id, { lease_deadline: deadline, last_seen_at: now() });
          // The lease was read before the update's await (#807 P3 A6e2): one finished meanwhile is refused here, which
          // rolls the new deadline back, and stays finished.
          if (leases.get(capability) !== lease) stale(p, context, capability);
          return { lease, deadline };
        }, ({ lease, deadline }) => {
          // Nothing awaits between the body's check and here; kept as the in-memory side's own guard.
          if (leases.get(capability) !== lease) stale(p, context, capability);
          lease.expiresAt = deadline;
          if (hooks) lease.hooks = hooks;
          return { lease };
        });
        return describe(lease);
      }).catch(error => refused(p, context, error));
    },
    async pending(p: DeliveryPrincipal, context: SessionContext, capability: string, limit = 100): Promise<PendingDelivery[]> {
      return hosted.control(p, context, false, async row => {
        const lease = await get(p, context, capability, row);
        await testPauseAsync("hosted:pending:in-gate");
        await get(p, context, capability, await store.get(pool, row.session_id));
        let items = (await application.pending(application.repo.read, lease.session, limit)).map(event => itemOf(event, lease));
        // Security audit F-03 (#854): a host without context starts a turn for every item it's given, so
        // after the ownership's first drain (local mode's) a lone non-waking item (ungranted,
        // deferred, a digest) stays unreceipted until a waking one arrives to carry it. A full page with
        // none waking goes out anyway: a direct item is receipted only in order, so holding it back would
        // starve every item behind it (so a sender who fills a page can still start turns).
        if (!lease.context && drained.has(drainKey(lease)) && items.length < limit && !items.some(item => item.actionable)) items = [];
        const unseen = items.filter(item => !lease.issued.has(item.id));
        if (lease.issued.size + unseen.length > 1000) { countRefusal("delivery_receipts"); throw new ApplicationError("receipt_capacity", "delivery lease receipt capacity reached; release and reopen"); }
        for (const item of unseen) lease.issued.set(item.id, { item: structuredClone(item), ...(item.event.kind === "board" ? { ref: refOf(item.event.item) } : {}) });
        if (!items.length) drained.add(drainKey(lease));
        return items;
      }).catch(error => refused(p, context, error));
    },
    async receipt(p: DeliveryPrincipal, context: SessionContext, capability: string, ids: string[]): Promise<void> {
      return hosted.control(p, context, false, async () => {
        await testPauseAsync("hosted:receipt:before-txn");
        await store.write(async tx => {
          testPause("hosted:receipt:in-txn");
          // Locked before its generation is judged against the receipts (#807 P3 C8 R2).
          const row = "id" in context ? await store.lock(tx, context.id) : undefined;
          const lease = await get(p, context, capability, row, tx);
          if (!row || row.root_session_id) stale(p, context, capability);
          if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) stale(p, context, capability);
          const records: Issued[] = [];
          // Each board's visibility read once, on the body's Tx (#807 P3 B5a2).
          const boardSeen = new Map<string, boolean>();
          for (const id of ids) {
            const issued = lease.issued.get(id), r: Acked = issued ? { ...issued.item, board: boardOf(issued.item) } : lease.acknowledged.get(id) ?? stale(p, context, capability);
            if (r.ownership !== row.ownership_id || r.bind_gen !== row.bind_gen || (r.address !== undefined && !lease.session.addresses.includes(r.address))) stale(p, context, capability);
            if (r.board !== undefined) {
              let seen = boardSeen.get(r.board);
              if (seen === undefined) boardSeen.set(r.board, seen = (await application.boardsVisible(tx, lease.session, [r.board])).get(r.board) === true);
              if (!seen) stale(p, context, capability);
            }
            if (issued) records.push(issued);
          }
          const direct = records.filter(r => r.item.event.kind === "direct");
          if (direct.length) {
            const unread = (await application.pending(tx, lease.session, 100)).filter(e => e.kind === "direct");
            const requested = new Set(direct.map(r => r.item.id));
            if (unread.length < direct.length || unread.slice(0, direct.length).some(e => !requested.has(itemOf(e, lease).id))) stale(p, context, capability);
          }
          await application.receiptDirect(tx, lease.session, direct.map(r => r.item.event.kind === "direct" ? r.item.event.message.id : stale(p, context, capability)));
          await application.receiptBoards(tx, lease.session, records.filter(r => r.ref).map(r => r.ref!));
          return { lease, records };
        }, ({ lease, records }) => {
          // No lease recheck: get rechecked after its await, the body holds the queue, and a lease a shutdown finished
          // since is detached (its maps cleared), so writing to it changes nothing a caller reads.
          for (const { item } of records) {
            lease.issued.delete(item.id);
            lease.acknowledged.set(item.id, { ownership: item.ownership, bind_gen: item.bind_gen, ...(item.address !== undefined ? { address: item.address } : {}), ...(boardOf(item) !== undefined ? { board: boardOf(item) } : {}) });
          }
          drained.add(drainKey(lease));
          while (lease.acknowledged.size > ACKED_HISTORY) lease.acknowledged.delete(lease.acknowledged.keys().next().value!);
        });
      }).catch(error => refused(p, context, error));
    },
    async release(p: DeliveryPrincipal, context: SessionContext, capability: string) {
      return hosted.control(p, context, true, async row => {
        await store.write(async tx => {
          await get(p, context, capability, await store.lock(tx, row.session_id), tx);
          await store.end(tx, row.session_id, "closed", now());
        });
      }, () => undefined).catch(error => refused(p, context, error));
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
        await store.write(async tx => {
          if (matches(lease, await store.lock(tx, lease.sessionId))) await store.end(tx, lease.sessionId, "closed", now());
          await hosted.settle(tx, lease.sessionId);
        }, () => {
          finish(lease);
        });
      });
    },
    revalidate() { hosted.sweep().catch(e => hostedFailure("hosted.sweep", e)); },
    close() {
      stopped = true; unlisten(); unwatch();
      // The capability is dropped, but the lease row stays; a restart credits it with the downtime (#423).
      for (const lease of [...leases.values()]) { hosted.auditAs(pool, lease.sessionId, "hosted.lease_detached", { reason: "shutdown" }, lease.principal); finish(lease); }
    },
  };
  return service;
}
export type Delivery = ReturnType<typeof createDelivery>;
