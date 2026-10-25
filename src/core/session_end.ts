// Session end (#284 decisions 4 and 10): one transaction that leaves nothing
// deliverable against an ended ID. Its unread direct mail bounces to the
// senders, its claims are released (queue posts redelivered, watchers told),
// its subscriptions, pushes, mutes, watches, read points and unbound uploads
// go, and each alias it held is released. Its ids row stays, marked ended,
// for the id_ended hint, until retention prunes it.
//
// Mail tables differ per mode (local `messages`/`cursors`/`dm_acks`, the
// server's Repo), so they're reached through a MailPort; every other table is
// core.
import type { Database } from "bun:sqlite";

import { writeCoreAudit } from "./audit.ts";
import { addressParts } from "./addresses.ts";
import { forgetHandle } from "./boards.ts";
import { logBinding } from "./bindings.ts";
import { release, sweepIn } from "./claims.ts";
import { CoreError } from "./errors.ts";
import { testPause } from "../shared/testpause.ts";

/** The ended ID's mail, as its mode stores it. Calls run inside the end's transaction. */
export interface MailPort {
  /** Direct mail to `id` it never read: past its read point, and not sent by itself. */
  unread(id: string): { id: number; sender: string }[];
  /** A bounce from `from` to `to`, threaded under the bounced message. */
  bounce(from: string, to: string, parentId: number, body: string, now: number): void;
  /** `id`'s read points and acks. */
  dropReader(id: string): void;
}

export type EndedSession = {
  /** The aliases it held, now released. */
  held: string[];
  /** Addresses to poke once the transaction commits: bounce recipients, release and redelivery wakes. */
  wake: string[];
};

const NOT_ENDED: EndedSession = { held: [], wake: [] };

/**
 * End session `id`. Callers are inside a BEGIN IMMEDIATE transaction and
 * poke `wake` after it commits; freed upload bytes go with the next blob
 * sweep. `why` details the release events (a reap names the dead pid).
 * `legacyNames`: a name a 1.x process holds through its bindings row.
 * A session already ended is left alone.
 */
export function endSession(
  db: Database,
  mail: MailPort,
  id: string,
  opts: { why?: string | null; legacyNames?: string[]; now?: number } = {},
): EndedSession {
  const now = opts.now ?? Date.now();
  const row = db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(id) as { ended_at: number | null } | null;
  if (row?.ended_at != null) return NOT_ENDED;
  const holds = (db.prepare(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address`).all(id) as { address: string }[]).map((r) => r.address);
  const held = [...new Set([...holds, ...(opts.legacyNames ?? [])])];
  db.prepare(`UPDATE ids SET ended_at = ?, held_aliases_json = ? WHERE id = ?`).run(now, JSON.stringify(held), id);
  // A send that reaches the write lock after this point is refused with
  // id_ended; one that committed before it is in `unread` below.
  testPause("end:in-txn");

  const wake = new Set<string>();
  const body = bounceBody(id, now, held);
  for (const m of mail.unread(id)) {
    // A bounce to an ID that has itself ended would only bounce back.
    if (isEndedId(db, m.sender)) continue;
    mail.bounce(id, m.sender, m.id, body, now);
    wake.add(m.sender);
  }

  // Lapsed claims first: release() refuses one, which would roll the end back.
  for (const h of sweepIn(db, now)) wake.add(h);
  const claims = db.prepare(`SELECT key FROM claims WHERE holder = ? AND expires_at > ?`).all(id, now) as { key: string }[];
  for (const c of claims) {
    try {
      for (const h of release(db, id, c.key, "session ended", { session: id }).wake) wake.add(h);
    } catch (e) {
      // It lapsed since the select; the sweep below takes it.
      if (!(e instanceof CoreError)) throw e;
    }
  }
  for (const h of sweepIn(db, Date.now())) wake.add(h);

  forgetHandle(db, id);
  mail.dropReader(id);
  db.prepare(`DELETE FROM attachments WHERE uploader = ? AND message_id IS NULL AND post_id IS NULL`).run(id);

  db.prepare(`DELETE FROM alias_holds WHERE id = ?`).run(id);
  const detail = opts.why ? `session_end: ${opts.why}` : "session_end";
  for (const name of held) logBinding(db, id, name, "released", detail, now);
  writeCoreAudit(db, "id.ended", id, id, { held, why: opts.why ?? null, bounced: wake.size });
  wake.delete(id);
  return { held, wake: [...wake] };
}

function isEndedId(db: Database, address: string): boolean {
  if (addressParts(address)?.kind !== "id") return false;
  const r = db.prepare(`SELECT ended_at FROM ids WHERE id = ?`).get(address) as { ended_at: number | null } | null;
  return r?.ended_at != null;
}

function heldText(held: string[]): string {
  return held.length ? `it held ${held.map((a) => `\`${a}\``).join(", ")}` : "it held no alias";
}

export function bounceBody(id: string, endedAt: number, held: string[]): string {
  return `${id} ended at ${new Date(endedAt).toISOString()} before reading this; ${heldText(held)}.`;
}

/**
 * Refuse a send or mention to an ID that can't receive it, inside the
 * sender's write transaction so it can't race the end: an ended ID
 * (id_ended, naming what it held), one with no row (not_found: never
 * existed, or pruned past retention), a viewer (not_found) or a tools-only
 * session (no_delivery, naming the alias its owner writes as).
 */
export function assertDeliverableId(db: Database, id: string, owner?: () => string | null): void {
  const r = db.prepare(`SELECT ended_at, held_aliases_json, delivery, viewer FROM ids WHERE id = ?`).get(id) as
    | { ended_at: number | null; held_aliases_json: string | null; delivery: string; viewer: number }
    | null;
  if (!r || r.viewer) throw new CoreError(`not_found: no session ${id}`);
  if (r.ended_at != null) {
    const held = r.held_aliases_json ? (JSON.parse(r.held_aliases_json) as string[]) : [];
    throw new CoreError(`id_ended: ${id} ended at ${new Date(r.ended_at).toISOString()}; ${heldText(held)}`);
  }
  if (r.delivery === "none") {
    const alias = owner?.();
    throw new CoreError(`no_delivery: ${id} is a tools-only session and receives nothing${alias ? `; send to ${alias}` : ""}`);
  }
}
