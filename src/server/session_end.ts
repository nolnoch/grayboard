// The server's session end (#807 P3 C10d2-a, docs/future/postgres-server.md D8 P3): core endSession's steps, in its
// order, composed over the Repo's groups on the caller's Tx and judged by the async BoardAccess, so the end runs on any
// store. The store keeps only the row-level step (sessionEnd.end: lock the row, mark it ended, return its holds and
// children). Local mode keeps core endSession; the rules and texts are core's (bounceBody, the release note, the
// binding detail, the id.ended row), so the two ends write the same rows (tests: server/session_end.test.ts).
import { addressParts } from "../core/addresses.ts";
import { CoreError } from "../core/errors.ts";
import { bounceBody, type EndedSession } from "../core/session_end.ts";
import { testPauseAsync } from "../shared/testpause.ts";
import { boardAccess, type BoardAccess } from "./access.ts";
import { serverRelease, sweepClaims } from "./claims.ts";
import type { Repo } from "./db.ts";
import type { HumanReach } from "./policy.ts";
import type { EndAuditSink, SessionEndPort } from "./store/session_end.ts";
import type { Tx } from "./store/tx.ts";

const NOT_ENDED: EndedSession = { ended: false, held: [], wake: [] };

/**
 * End session `id` in the caller's transaction (core endSession's contract): its unread direct mail bounces to the
 * senders, its claims are released (queue posts redelivered, watchers told), its subscriptions, pushes, mutes, watches,
 * read points and unbound uploads go, each alias it held is released, and its unended children end with it. The
 * caller pokes `wake` once the transaction commits. `why` details the release events; the id.ended row goes to
 * `audit`, awaited. A session already ended is left alone.
 */
export async function endSessionServer(
  repo: Repo, access: BoardAccess, tx: Tx, id: string, opts: { why: string; now: number; audit: EndAuditSink },
): Promise<EndedSession> {
  const { now } = opts;
  const row = await repo.sessionEnd.end(tx, id, now);
  if (!row) return NOT_ENDED;
  const { held } = row;
  // A send that reaches the row after this point is refused with id_ended; one that committed before it is in
  // unreadFor below.
  await testPauseAsync("end:in-txn");

  const wake = new Set<string>();
  // One bounce per sender (#334), threaded under its latest unread message and naming the others. `bounced` and
  // `unbounced` count messages.
  const bySender = new Map<string, number[]>();
  for (const m of await repo.messages.unreadFor(tx, id)) {
    const ids = bySender.get(m.sender);
    if (ids) ids.push(m.id);
    else bySender.set(m.sender, [m.id]);
  }
  let bounced = 0;
  let unbounced = 0;
  for (const [sender, ids] of bySender) {
    // A bounce to an ID that has ended would only bounce back, and one whose row is gone (pruned) can never be read.
    if (!(await liveIdOrAlias(repo, tx, sender))) {
      unbounced += ids.length;
      continue;
    }
    const latest = Math.max(...ids);
    // A parent retracted first (Postgres only) bounces nothing and wakes no one.
    if (!(await repo.messages.bounce(tx, id, sender, latest, bounceBody(id, now, held, ids.filter((x) => x !== latest).sort((a, b) => a - b)), now))) continue;
    bounced += ids.length;
    wake.add(sender);
  }

  // Lapsed claims first, so they end as lapses (announced, redelivered) rather than releases.
  for (const h of (await sweepClaims(repo, access, tx, now)).wake) wake.add(h);
  // A release that fails for any reason but a lapse (the sweep below takes those) still frees the claim, unannounced,
  // and the failure goes in the id.ended audit: an end must not leave a claim on an ID that can't act.
  const releaseFailed: { key: string; error: string }[] = [];
  for (const key of await repo.claims.heldBy(tx, id, now)) {
    try {
      for (const h of (await serverRelease(repo, access, tx, id, key, "session ended", { session: id })).wake) wake.add(h);
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      const cur = await repo.claims.release(tx, key, id, Date.now());
      if (!cur) continue;
      await repo.claims.takeWatchers(tx, key);
      await repo.claims.logEvent(tx, "release", id, { ...cur, note: `session ended; announce failed: ${e.message}` }, Date.now());
      releaseFailed.push({ key, error: e.message });
    }
  }
  for (const h of (await sweepClaims(repo, access, tx, Date.now())).wake) wake.add(h);

  await repo.boards.forget(tx, id);
  await repo.messages.dropReader(tx, id);
  await repo.attachments.dropUnboundOf(tx, id);

  for (const name of held) await repo.bindings.release(tx, name, id);
  const detail = opts.why ? `session_end: ${opts.why}` : "session_end";
  for (const name of held) await repo.bindings.log(tx, id, name, "released", detail, now);
  // Its child sessions (#523) act under its addresses, so they end with it, each audited.
  for (const child of row.children) {
    for (const h of (await endSessionServer(repo, access, tx, child, { why: `its root ${id} ended`, now, audit: opts.audit })).wake) wake.add(h);
  }
  await opts.audit("id.ended", id, id, {
    principal: row.principal,
    held,
    why: opts.why,
    bounced,
    ...(unbounced ? { unbounced } : {}),
    ...(releaseFailed.length ? { release_failed: releaseFailed } : {}),
    ...(row.children.length ? { children: row.children } : {}),
  });
  wake.delete(id);
  return { ended: true, held, wake: [...wake] };
}

/** False for an ID sender that has ended or whose row is gone; an alias is durable, so always true. */
async function liveIdOrAlias(repo: Repo, tx: Tx, address: string): Promise<boolean> {
  if (addressParts(address)?.kind !== "id") return true;
  const r = await repo.bindings.idRow(tx, address);
  return r !== undefined && r.ended_at === null;
}

/**
 * The session-end port the hosted store ends a released child's ID through (SessionEndPort): endSessionServer over
 * `repo`, judged by a BoardAccess at `humanReach`. openDatabase's caller passes it (OpenOptions.sessionEnd), so no
 * store module imports this one.
 */
export function sessionEndPort(humanReach: HumanReach): (repo: Repo) => SessionEndPort {
  return (repo) => {
    const access = boardAccess(repo, humanReach);
    return { end: (tx, id, opts) => endSessionServer(repo, access, tx, id, opts) };
  };
}
