import { createHash } from "node:crypto";
import { BindGate } from "../shared/bindgate.ts";
import { testPause, testPauseAsync } from "../shared/testpause.ts";
import { asSessionId, boundInstructions, describeCandidate, type Candidate } from "../core/bindings.ts";
import { HUMAN_NAME, normalizeIdentityName } from "../shared/addressing.ts";
import { ApplicationError, UNBOUND_READS, type Application, type ApplicationSession, type DeliverySink } from "./application.ts";
import type { OAuthPrincipal } from "./oauth.ts";
import { harnessFor } from "./oauth-config.ts";
import type { HostedEnd, HostedSession } from "./hosted-types.ts";
import { writeAudit } from "./audit.ts";
import { hostedFailure } from "./hosted-diagnostics.ts";

export type SessionContext = { id: string; raw: string } | { missing: string };
export function hostedSessionId(user: number, client: string, raw: string): string {
  const hash = createHash("sha256");
  for (const value of [String(user), client, raw]) {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return asSessionId(hash.digest("hex").slice(0, 16));
}
// The one source mapping (#414): `_meta`, child registration and the attachment byte
// routes all map a raw source through the principal's own key, namespaced per client.
export function sourceContext(principal: OAuthPrincipal, raw: unknown): SessionContext {
  if (principal.sourceKey === null) return { missing: "the client has no mapped source" };
  if (typeof raw !== "string" || !raw.length || raw.length > 1024 || /[\x00-\x1f\x7f]/.test(raw)) return { missing: `the key _meta["${principal.sourceKey}"] is missing` };
  return { id: hostedSessionId(principal.authed.user_id, principal.clientId, raw), raw };
}
export function sessionContext(principal: OAuthPrincipal, meta: unknown): SessionContext {
  const key = principal.sourceKey;
  return sourceContext(principal, key !== null && meta && typeof meta === "object" ? (meta as Record<string, unknown>)[key] : undefined);
}
// A hosted session with no name reads and nothing else (master's model; see
// UNBOUND_READS): its instructions say so, unlike a WSS session's, which acts
// as its ID (#284 S13).
export function hostedUnboundInstruction(candidates: Candidate[], notes: string[] = []): string {
  const why = notes.map((n) => ` ${n}`).join("");
  const list = candidates.length ? ` Candidates (free now): ${candidates.map(describeCandidate).join("; ")}.` : "";
  return `This session has no bus name yet.${why} Bind one with bind(name) once you know your task, or don't bind if the task doesn't need the bus.${list} Until then you can read boards, peers and claims; you send and receive nothing.`;
}
// A hosted bind's result: a hosted session holds one name, so a bind
// replaces it and its claims follow (master's #182 text, kept for hosted).
// Hosted holds one name, so its claims move with it; S6 applies to WSS and local (#407).
function hostedBindOk(name: string, previous: string | null, moved: string[], instructions: (general: boolean) => string[], notes: string[] = []) {
  const text = [
    previous
      ? `Bound to "${name}" (was "${previous}"); DMs queued to "${previous}" stay for its next holder.`
      : `Bound to "${name}"; the instructions' note that this session has no bus name no longer applies.`,
    ...(moved.length ? [`Your claims moved from "${previous}" to "${name}": ${moved.join(", ")}.`] : []),
    ...notes,
    ...instructions(previous === null),
  ].join(" ");
  return { content: [{ type: "text" as const, text }], structuredContent: { name, instructions: instructions(true) } };
}
const quietSink: DeliverySink = { deliver() {}, probe: async () => true, closed() {} };
const writeReads = new Set([...UNBOUND_READS, "whoami", "dm_history", "dm_thread", "dm_inbox"]);
// How often the sweep timer records the server's liveness; after a crash the
// restart credit can overshoot the real downtime by at most this (#423).
const HEARTBEAT_MS = 1000;
// A running server's alive_at lags by up to a heartbeat plus a timer tick
// (and event-loop delay); a gap within this bound is no measurable downtime.
const LIVE_STALENESS_MS = 2 * HEARTBEAT_MS;
const DELIVERY_TTL_MS = 30_000;
export function createHostedSessions(application: Application, options: { now?: () => number; idleSeconds?: number; isAuthorized(principal: OAuthPrincipal): boolean }) {
  const repo = application.repo, store = repo.hosted;
  const now = options.now ?? Date.now;
  const rawIdle = options.idleSeconds ?? Number(process.env.GRAYBOARD_HOSTED_IDLE_SECONDS ?? "900");
  if (!Number.isSafeInteger(rawIdle) || rawIdle < 1) throw new Error("GRAYBOARD_HOSTED_IDLE_SECONDS must be a positive integer");
  const idle = rawIdle * 1000;
  // A delivery lease's TTL (createDelivery reads it from the service); the
  // restart credit caps a deadline at one TTL past startup (#423).
  const leaseTtl = DELIVERY_TTL_MS;
  const gates = new Map<string, { gate: BindGate; users: number }>();
  const limits = { user: 256, global: 4096, children: 128 };
  function admit(user: number, root?: string) {
    const rows = store.all();
    if (rows.length >= limits.global || rows.filter(r => r.user_id === user).length >= limits.user || (root && rows.filter(r => r.root_session_id === root).length >= limits.children)) throw new ApplicationError("bad_request", "hosted session capacity reached; end unused sessions first");
  }
  const holders = new Map<string, { row: HostedSession; session: ApplicationSession }>();
  const listeners = new Set<() => void>();
  let stopped = false;
  const gate = (id: string) => {
    const enter = async <T>(writer: boolean, fn: () => Promise<T>): Promise<T> => {
      let entry = gates.get(id);
      if (!entry) gates.set(id, entry = { gate: new BindGate(), users: 0 });
      entry.users++;
      try { return await entry.gate[writer ? "bind" : "call"](fn); }
      finally { if (--entry.users === 0 && gates.get(id) === entry) gates.delete(id); }
    };
    return { call: <T>(fn: () => Promise<T>) => enter(false, fn), bind: <T>(fn: () => Promise<T>) => enter(true, fn) };
  };
  const audit = (id: string, action: `hosted.${string}`, detail: Record<string, unknown>, principal?: OAuthPrincipal) => {
    const row = store.get(id);
    const actor = principal?.authed.user_email ?? (row && repo.users.findById(row.user_id)?.email) ?? null;
    writeAudit(repo, action, actor, id, { ...detail, client_id: principal?.clientId ?? row?.client_id ?? null });
  };
  function authorized(p: OAuthPrincipal) {
    if (stopped || !options.isAuthorized(p)) throw new ApplicationError("unauthenticated", "unauthenticated");
  }
  function rowFor(p: OAuthPrincipal, context: SessionContext, create = true): HostedSession | undefined {
    if (!("id" in context)) return undefined;
    let row = store.get(context.id);
    if (row && (row.user_id !== p.authed.user_id || row.client_id !== p.clientId)) throw new ApplicationError("not_found", "session not found");
    if (!row && create) {
      admit(p.authed.user_id);
      const t = now();
      row = { session_id: context.id, ownership_id: store.start(context.id, p.authed.user_id, p.clientId, t), user_id: p.authed.user_id,
        client_id: p.clientId, grant_id: p.grantId, source_session_id: context.raw, name: null, bind_gen: 0,
        root_session_id: null, place: null, lease_deadline: null, created_at: t, last_seen_at: t };
      application.hostedRegister(p.authed, row.session_id, harnessFor(p.clientId));
      store.insert(row);
    }
    return row;
  }
  function rootOf(row: HostedSession): HostedSession {
    const root = row.root_session_id ? store.get(row.root_session_id) : row;
    if (!root || root.ownership_id !== row.ownership_id) throw new ApplicationError("unbound", "unbound; its root's ownership changed, so the root must register this child again (session_register)");
    return root;
  }
  function rootOnly(row: HostedSession) {
    if (row.root_session_id) throw new ApplicationError("child_session", `this session acts under its root ${row.root_session_id}; bind and delivery are the root's. Call them from the root session.`);
  }
  function touch(row: HostedSession) {
    const root = rootOf(row), t = now();
    store.update({ ...root, last_seen_at: t });
    if (row.session_id !== root.session_id) store.update({ ...row, last_seen_at: t });
  }
  function reconcile() {
    const rows = store.all().filter(r => !r.root_session_id && r.name);
    const live = new Map(rows.map(r => [r.session_id, r]));
    for (const [id, holder] of holders) {
      const row = live.get(id);
      if (!row || row.ownership_id !== holder.row.ownership_id || row.bind_gen !== holder.row.bind_gen) {
        application.close(holder.session);
        holders.delete(id);
      }
    }
    for (const row of rows) if (!holders.has(row.session_id)) {
      const user = repo.users.findById(row.user_id);
      if (!user) continue;
      const { session } = application.hostedSession({ user_id: user.id, user_email: user.email, session_id: 0 }, row.session_id, row.name, row.place,
        { ...quietSink, probe: async () => gate(row.session_id).bind(async () => {
          sweep();
          const current = store.get(row.session_id);
          if (!current || current.ownership_id !== row.ownership_id || current.bind_gen !== row.bind_gen) return false;
          if (current.lease_deadline === null && current.last_seen_at < now() - idle) {
            store.atomic(() => store.end(current.session_id, "idle", now()));
            return false;
          }
          return true;
        }) }, true);
      holders.set(row.session_id, { row, session });
    }
    for (const listener of listeners) listener();
  }
  function sweep() {
    if (stopped) return;
    store.atomic(() => {
      for (const row of store.all()) if (!row.root_session_id) {
        if (repo.users.findById(row.user_id)?.disabled_at != null) store.end(row.session_id, "disabled", now());
        else if (row.lease_deadline !== null && row.lease_deadline <= now()) store.end(row.session_id, "expired", now(), row.lease_deadline);
        else if (!row.name && row.lease_deadline === null && row.last_seen_at < now() - idle) store.end(row.session_id, "idle", now());
      }
    });
    reconcile();
  }
  // The lease and idle clocks stop while the server is down (#423). A root
  // whose lease was still live at the last heartbeat gets its deadline pushed
  // out by the downtime, capped at one TTL past now: a stale heartbeat (a
  // rollback to a release without it, or failing heartbeat writes while
  // renewals succeed) must not let a dead owner hold its name for longer. An
  // unleased root that wasn't yet idle at the last heartbeat gets its
  // last_seen_at moved the same way, capped at now. A lease that had already
  // expired while the server was up, and a disabled user's root, are left for
  // the sweep. With no heartbeat yet on this schema there is no downtime to
  // measure, and a gap within LIVE_STALENESS_MS is indistinguishable from a
  // live server (a concurrent opener). Writing alive_at in the same
  // transaction makes a second start measure ~0, so the credit is applied once.
  function creditDowntime() {
    store.atomic(() => {
      const t = now(), alive = store.aliveAt(), downtime = alive === undefined ? null : t - alive;
      let credited = 0;
      if (alive !== undefined && downtime !== null && downtime > LIVE_STALENESS_MS) {
        for (const row of store.all()) {
          if (row.root_session_id || repo.users.findById(row.user_id)?.disabled_at != null) continue;
          let credit: { field: "lease_deadline" | "last_seen_at"; before: number; after: number } | undefined;
          if (row.lease_deadline !== null) {
            if (row.lease_deadline > alive) credit = { field: "lease_deadline", before: row.lease_deadline, after: Math.min(row.lease_deadline + downtime, t + leaseTtl) };
          } else if (row.last_seen_at > alive - idle) credit = { field: "last_seen_at", before: row.last_seen_at, after: Math.min(row.last_seen_at + downtime, t) };
          if (!credit || credit.after <= credit.before) continue;
          store.update({ ...row, [credit.field]: credit.after });
          audit(row.session_id, "hosted.lease_restart_credit", { ownership: row.ownership_id, field: credit.field, downtime_ms: downtime, before: credit.before, after: credit.after });
          credited++;
        }
      }
      // One row per start, credited or not, so an outage is auditable even
      // when no lease was live (alive_at null: no heartbeat on this schema yet).
      writeAudit(repo, "server.started", null, null, { alive_at: alive ?? null, now: t, downtime_ms: downtime, credited });
      store.heartbeat(t);
    });
  }
  async function withGate<T>(p: OAuthPrincipal, context: SessionContext, writer: boolean, fn: (row: HostedSession | undefined) => Promise<T>): Promise<T> {
    authorized(p);
    if (!("id" in context)) return fn(undefined);
    const retry = Symbol("root changed");
    for (;;) {
      const before = store.get(context.id);
      const id = before?.root_session_id ?? context.id;
      const result = await gate(id)[writer ? "bind" : "call"](async () => {
        authorized(p);
        sweep();
        const row = store.atomic(() => { const r = rowFor(p, context)!; touch(r); return r; });
        if ((row.root_session_id ?? row.session_id) !== id) return retry;
        return fn(row);
      });
      if (result !== retry) return result as T;
    }
  }
  function attach(p: OAuthPrincipal, row: HostedSession): HostedSession {
    authorized(p);
    const fresh = store.get(row.session_id);
    if (!fresh) throw new ApplicationError("unbound", "unbound; bind again");
    rootOnly(fresh);
    fence(p, row, row);
    if (fresh.grant_id === p.grantId) return fresh;
    testPause("hosted:attach:in-txn");
    authorized(p);
    for (const child of store.all().filter(r => r.ownership_id === fresh.ownership_id)) store.update({ ...child, grant_id: p.grantId });
    audit(row.session_id, "hosted.grant_attached", { from: fresh.grant_id, to: p.grantId, ownership: fresh.ownership_id });
    audit(row.session_id, "hosted.lease_closed", { reason: "reattached" });
    return { ...fresh, grant_id: p.grantId };
  }
  function snapshot(p: OAuthPrincipal, row?: HostedSession) {
    const root = row ? rootOf(row) : undefined;
    return { ...application.hostedSession(p.authed, row?.session_id ?? "no-context", root?.name ?? null, root?.place ?? null, quietSink), stamp: root ? { ownership: root.ownership_id, generation: root.bind_gen } : undefined };
  }
  function fence(p: OAuthPrincipal, row: HostedSession | undefined, root: HostedSession | undefined) {
    authorized(p);
    if (!row || !root) return;
    const fresh = store.get(row.session_id);
    const current = fresh ? rootOf(fresh) : undefined;
    if (!fresh || fresh.ownership_id !== row.ownership_id || fresh.root_session_id !== row.root_session_id || !current || current.session_id !== root.session_id || current.ownership_id !== root.ownership_id || current.bind_gen !== root.bind_gen || current.name !== root.name || (current.lease_deadline !== null && current.lease_deadline <= now())) throw new ApplicationError("unbound", "session binding changed; select the current binding again");
  }
  const service = {
    application,
    limits,
    get gateCount() { return gates.size; },
    now,
    leaseTtl,
    gate,
    row(id: string) { return store.get(id); },
    rootOf,
    rootOnly,
    audit,
    reconcile,
    sweep,
    listen(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async snapshot(p: OAuthPrincipal, context: SessionContext) { return withGate(p, context, false, async row => snapshot(p, row)); },
    async run<T>(p: OAuthPrincipal, context: SessionContext, tool: string, fn: (session: ApplicationSession) => T): Promise<T> {
      return withGate(p, context, false, async row => {
        const root = row ? rootOf(row) : undefined;
        if (!root?.name && !UNBOUND_READS.has(tool) && tool !== "whoami") throw new ApplicationError("unbound", "unbound; bind a name first, or have this session's root register it as a child (session_register)");
        const selected = snapshot(p, row);
        try {
          await testPauseAsync("hosted:tool:in-gate");
          return store.atomic(() => {
            fence(p, row, root);
            const value = fn(selected.session);
            if (value instanceof Promise) throw new Error("hosted native effects must be synchronous");
            if (!writeReads.has(tool)) audit(row!.session_id, "hosted.write", { tool, session: row!.session_id, root: root!.session_id, grant: p.grantId, name: root!.name });
            return value;
          });
        } finally { application.close(selected.session); }
      });
    },
    async transfer<T>(p: OAuthPrincipal, context: SessionContext, fn: (session: ApplicationSession, guard: () => void) => Promise<T>): Promise<T> {
      return withGate(p, context, false, async row => {
        const root = row ? rootOf(row) : undefined;
        if (!root?.name) throw new ApplicationError("unbound", "attachments require a bound source session");
        const selected = snapshot(p, row);
        const guard = () => { store.atomic(() => fence(p, row, root)); };
        try {
          guard();
          const value = await fn(selected.session, guard);
          guard();
          return value;
        } finally { application.close(selected.session); }
      });
    },
    async owning<T, R = T>(p: OAuthPrincipal, context: SessionContext, fn: (row: HostedSession) => T, committed?: (value: T) => R | Promise<R>): Promise<R> {
      return withGate(p, context, true, async row => {
        if (!row) throw new ApplicationError("unbound", `this request carries no session context (${("missing" in context ? context.missing : "missing")}), so it can only read.`);
        rootOnly(row);
        await testPauseAsync("hosted:owning:before-txn");
        const result = store.atomic(() => fn(attach(p, row)));
        reconcile();
        return committed ? committed(result) : result as unknown as R;
      });
    },
    async control<T>(p: OAuthPrincipal, context: SessionContext, writer: boolean, fn: (row: HostedSession) => Promise<T> | T): Promise<T> {
      return withGate(p, context, writer, async row => {
        if (!row) throw new ApplicationError("unbound", "unbound; bind a name first");
        rootOnly(row);
        return fn(row);
      });
    },
    async whoami(p: OAuthPrincipal, context: SessionContext) {
      return withGate(p, context, false, async row => {
        const root = row ? rootOf(row) : undefined;
        return { name: root?.name ?? null, ownership: root?.ownership_id ?? null,
          ...(row?.root_session_id ? { root: root?.session_id, child: true } : {}),
          ...(!root?.name ? { unbound: true, candidates: application.hostedCandidates(p.authed) } : {}) };
      });
    },
    async bind(p: OAuthPrincipal, context: SessionContext, args: { name: string; create?: boolean; where?: string }) {
      const normalized = normalizeIdentityName(args.name);
      if (!normalized.ok) throw new ApplicationError("bad_request", normalized.error);
      const name = normalized.name;
      if (name === HUMAN_NAME) throw new ApplicationError("bad_request", "human is reserved for the trusted bridge");
      const result = await service.owning(p, context, row => {
        testPause("hosted:bind:in-txn");
        if (row.name === name) return { name, previous: row.name, moved: [] as string[], ownership: row.ownership_id };
        const full = `${p.authed.user_email}/${name}`;
        const other = store.all().find(r => r.user_id === p.authed.user_id && r.name === name && r.session_id !== row.session_id);
        if (other && ((other.lease_deadline !== null && other.lease_deadline <= now()) || (other.lease_deadline === null && other.last_seen_at < now() - idle))) {
          store.end(other.session_id, other.lease_deadline === null ? "idle" : "expired", now());
        } else if (other) {
          const holder = `the hosted session ${other.session_id}${other.place ? `, in ${other.place}` : ""}, last seen ${Math.floor((now() - other.last_seen_at) / 1000)}s ago`;
          application.hostedRefused(row.session_id, full, holder);
          throw new ApplicationError("identity_in_use", `identity "${name}" is already in use by ${holder}; bind another name.`, { holder });
        }
        // Any session's hold, live or in its WSS grace (#284 S4): a grace
        // holder may come back for it.
        const holder = application.aliasHolder(full);
        if (holder && holder.id !== row.session_id && !other) {
          const who = holder.who;
          application.hostedRefused(row.session_id, full, who);
          throw new ApplicationError("identity_in_use", `identity "${name}" is already in use by ${who}; bind another name.`, { holder: who });
        }
        const changed = application.hostedBind(p.authed, row.session_id, name, row.name, args.where ?? null, args.create === true);
        store.update({ ...row, name, bind_gen: row.bind_gen + 1, place: args.where ?? null });
        if (row.lease_deadline !== null) audit(row.session_id, "hosted.lease_closed", { reason: "rebound" });
        return { name, previous: row.name, ...changed, ownership: row.ownership_id };
      }, async result => {
        await testPauseAsync("hosted:bind:after-commit");
        authorized(p);
        return result;
      }).catch(error => {
        if (error instanceof ApplicationError && ["identity_in_use", "identity_unknown"].includes(error.code) && "id" in context) {
          application.hostedRefused(context.id, `${p.authed.user_email}/${name}`, error.message);
        }
        throw error;
      });
      const response = hostedBindOk(result.name, result.previous, result.moved,
        general => boundInstructions(result.name, general, () => [], []),
        [`No delivery lease is open for this session, so DMs to "${result.name}" wait until the client opens one (delivery_open).`]);
      return { ...response, structuredContent: { ...response.structuredContent, ownership: result.ownership } };
    },
    async register(p: OAuthPrincipal, context: SessionContext, child: string, via: string[] = []) {
      if (!("id" in context)) throw new ApplicationError("unbound", "registration requires session context");
      const mapped = sourceContext(p, child);
      if (!("id" in mapped) || !Array.isArray(via) || via.length > 16 || via.some(value => typeof value !== "string" || !value.length || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value))) throw new ApplicationError("invalid_registration", "invalid child session source or ancestry");
      const childId = mapped.id;
      if (childId === context.id) throw new ApplicationError("invalid_registration", "a session cannot register itself");
      const before = store.get(context.id);
      const ids = [context.id, childId].sort();
      const locked = async (index: number): Promise<unknown> => {
        if (index < ids.length) return gate(ids[index]!).bind(() => locked(index + 1));
        await testPauseAsync("hosted:register:before-txn");
        return store.atomic(() => {
          authorized(p);
          testPause("hosted:register:in-txn");
          const root = rowFor(p, context)!;
          if (root.root_session_id) throw new ApplicationError("root_is_child", `session ${root.session_id} is itself registered under ${root.root_session_id}; register ${childId} under ${root.root_session_id}.`);
          if (before) fence(p, before, before);
          const existing = store.get(childId);
          if (existing && (existing.user_id !== p.authed.user_id || existing.client_id !== p.clientId)) throw new ApplicationError("not_found", "session not found");
          if (existing?.name) throw new ApplicationError("child_bound", `session ${childId} holds "${existing.name}" as its own root (bound ${existing.created_at}, in ${existing.place}); end it with session_end from that session, or leave it as its own root.`);
          if (existing?.root_session_id && existing.root_session_id !== root.session_id) throw new ApplicationError("child_registered_elsewhere", `session ${childId} is registered under root ${existing.root_session_id}; a session has one root. session_end(${childId}) from ${existing.root_session_id} first.`);
          const descendants = store.all().filter(r => r.root_session_id === childId);
          if (descendants.length) throw new ApplicationError("has_children", `session ${childId} has ${descendants.length} registered children, so it can't become a child.`);
          if (!existing) admit(p.authed.user_id, root.session_id);
          else if (!existing.root_session_id && store.all().filter(r => r.root_session_id === root.session_id).length >= limits.children) throw new ApplicationError("bad_request", "hosted child capacity reached");
          const attached = attach(p, root);
          touch(attached);
          if (existing?.root_session_id === root.session_id) return { message: "already registered" };
          if (existing) store.end(existing.session_id, "closed", now());
          application.hostedRegister(p.authed, childId, harnessFor(p.clientId));
          store.insert({ session_id: childId, ownership_id: attached.ownership_id, user_id: p.authed.user_id, client_id: p.clientId, grant_id: p.grantId,
            source_session_id: child, name: null, bind_gen: 0, root_session_id: root.session_id, place: null, lease_deadline: null, created_at: now(), last_seen_at: now() });
          audit(root.session_id, "hosted.child_registered", { child: childId, ownership: root.ownership_id, source_session_id: child, via });
          return { message: "registered", child: childId, root: root.session_id };
        });
      };
      const result = await locked(0);
      reconcile();
      return result;
    },
    async end(p: OAuthPrincipal, context: SessionContext, session?: string) {
      if (!("id" in context)) throw new ApplicationError("unbound", "session_end requires session context");
      return withGate(p, context, true, async row => {
        if (!row) return { ended: false };
        const target = session ?? row.session_id;
        if (row.root_session_id && target !== row.session_id) rootOnly(row);
        const root = rootOf(row);
        store.atomic(() => {
          fence(p, row, root);
          const candidate = store.get(target);
          if (!candidate || candidate.user_id !== p.authed.user_id || candidate.client_id !== p.clientId || candidate.ownership_id !== row.ownership_id || (candidate.session_id !== row.session_id && candidate.root_session_id !== row.session_id)) throw new ApplicationError("not_found", "session not found");
          candidate.root_session_id ? store.childEnd(target, now()) : store.end(target, "closed", now());
        });
        reconcile();
        return { ended: true };
      });
    },
    release(id: string, reason: HostedEnd, deadline?: number) {
      store.atomic(() => store.end(id, reason, now(), deadline));
      reconcile();
    },
    close() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      for (const { session } of holders.values()) application.close(session);
      holders.clear(); listeners.clear();
      // A clean stop records its exact time, so the next start credits leases
      // with the real downtime rather than up to a heartbeat interval more.
      try { store.heartbeat(now()); } catch (e) { hostedFailure("hosted.heartbeat", e); }
    },
    instructions: hostedUnboundInstruction,
  };
  const unsubscribe = store.subscribe(reconcile);
  creditDowntime();
  sweep();
  let beat = now();
  const timer = setInterval(() => {
    try { sweep(); } catch (e) { hostedFailure("hosted.sweep", e); }
    const t = now();
    if (t - beat >= HEARTBEAT_MS || t < beat) try { store.heartbeat(t); beat = t; } catch (e) { hostedFailure("hosted.heartbeat", e); }
  }, 250);
  timer.unref();
  return service;
}
export type HostedSessions = ReturnType<typeof createHostedSessions>;
