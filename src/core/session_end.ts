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

import { coreAuditSink, type AuditSink } from "./audit.ts";
import { addressParts } from "./addresses.ts";
import { forgetHandle } from "./boards.ts";
import { logBinding } from "./bindings.ts";
import { logEvent, release, sweepIn, type Claim } from "./claims.ts";
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
  /** False when the session had already ended: this call changed nothing. */
  ended: boolean;
  /** The aliases it held, now released. */
  held: string[];
  /** Addresses to poke once the transaction commits: bounce recipients, release and redelivery wakes. */
  wake: string[];
};

const NOT_ENDED: EndedSession = { ended: false, held: [], wake: [] };

/**
 * End session `id`. Callers are inside a BEGIN IMMEDIATE transaction and
 * poke `wake` and sweep the freed upload bytes after it commits. `why` details the release events (a reap names the dead pid).
 * `legacyNames`: a name a 1.x process holds through its bindings row.
 * `audit`: where the id.ended row goes (the server's access_log); audit_log when absent.
 * A session already ended is left alone.
 */
export function endSession(
  db: Database,
  mail: MailPort,
  id: string,
  opts: { why?: string | null; legacyNames?: string[]; now?: number; audit?: AuditSink } = {},
): EndedSession {
  const now = opts.now ?? Date.now();
  const row = db.prepare(`SELECT ended_at, principal FROM ids WHERE id = ?`).get(id) as { ended_at: number | null; principal: string | null } | null;
  if (row?.ended_at != null) return NOT_ENDED;
  const holds = (db.prepare(`SELECT address FROM alias_holds WHERE id = ? ORDER BY bound_at, address`).all(id) as { address: string }[]).map((r) => r.address);
  const held = [...new Set([...holds, ...(opts.legacyNames ?? [])])];
  db.prepare(`UPDATE ids SET ended_at = ?, held_aliases_json = ? WHERE id = ?`).run(now, JSON.stringify(held), id);
  // A send that reaches the write lock after this point is refused with
  // id_ended; one that committed before it is in `unread` below.
  testPause("end:in-txn");

  const wake = new Set<string>();
  const body = bounceBody(id, now, held);
  let bounced = 0;
  let unbounced = 0;
  for (const m of mail.unread(id)) {
    // A bounce to an ID that has itself ended would only bounce back.
    if (isEndedId(db, m.sender)) {
      unbounced++;
      continue;
    }
    mail.bounce(id, m.sender, m.id, body, now);
    bounced++;
    wake.add(m.sender);
  }

  // Lapsed claims first, so they end as lapses (announced, redelivered) rather than releases.
  for (const h of sweepIn(db, now)) wake.add(h);
  const claims = db.prepare(`SELECT key FROM claims WHERE holder = ? AND expires_at > ?`).all(id, now) as { key: string }[];
  // A release that fails for any reason but a lapse (the sweep below takes
  // those) still frees the claim, unannounced, and the failure goes in the
  // id.ended audit: an end must not leave a claim on an ID that can't act.
  const releaseFailed: { key: string; error: string }[] = [];
  for (const c of claims) {
    try {
      for (const h of release(db, id, c.key, "session ended", { session: id }).wake) wake.add(h);
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      const cur = db.prepare(`SELECT * FROM claims WHERE key = ? AND holder = ? AND expires_at > ?`).get(c.key, id, Date.now()) as Claim | null;
      if (!cur) continue;
      db.prepare(`DELETE FROM claims WHERE key = ?`).run(c.key);
      db.prepare(`DELETE FROM claim_watches WHERE key = ?`).run(c.key);
      logEvent(db, "release", id, { ...cur, note: `session ended; announce failed: ${e.message}` }, Date.now());
      releaseFailed.push({ key: c.key, error: e.message });
    }
  }
  for (const h of sweepIn(db, Date.now())) wake.add(h);

  forgetHandle(db, id);
  mail.dropReader(id);
  db.prepare(`DELETE FROM attachments WHERE uploader = ? AND message_id IS NULL AND post_id IS NULL`).run(id);

  db.prepare(`DELETE FROM alias_holds WHERE id = ?`).run(id);
  const detail = opts.why ? `session_end: ${opts.why}` : "session_end";
  for (const name of held) logBinding(db, id, name, "released", detail, now);
  (opts.audit ?? coreAuditSink(db))("id.ended", id, id, {
    principal: row?.principal ?? null,
    held,
    why: opts.why ?? null,
    bounced,
    ...(unbounced ? { unbounced } : {}),
    ...(releaseFailed.length ? { release_failed: releaseFailed } : {}),
  });
  wake.delete(id);
  return { ended: true, held, wake: [...wake] };
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
export function assertDeliverableId(db: Database, id: string): void {
  const why = undeliverableId(db, id);
  if (why) throw why;
}

/**
 * assertDeliverableId's refusal. Its message reads `<code>: <detail>`, the
 * text a local tool error shows; the server sends `code` as the error
 * frame's code and `detail` as its message, so both modes read the same.
 */
export class Undeliverable extends CoreError {
  constructor(
    readonly code: "not_found" | "id_ended" | "no_delivery",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Why `id` can't receive a send or mention (assertDeliverableId's refusal), or null when it can. */
export function undeliverableId(db: Database, id: string): Undeliverable | null {
  const r = db.prepare(`SELECT ended_at, held_aliases_json, delivery, writes_as, viewer FROM ids WHERE id = ?`).get(id) as
    | { ended_at: number | null; held_aliases_json: string | null; delivery: string; writes_as: string | null; viewer: number }
    | null;
  if (!r || r.viewer) return new Undeliverable("not_found", `no session ${id}`);
  if (r.ended_at != null) {
    const held = r.held_aliases_json ? (JSON.parse(r.held_aliases_json) as string[]) : [];
    return new Undeliverable("id_ended", `${id} ended at ${new Date(r.ended_at).toISOString()}; ${heldText(held)}`);
  }
  if (r.delivery === "none") {
    return new Undeliverable("no_delivery", `${id} is a tools-only session and receives nothing${r.writes_as ? `; send to ${r.writes_as}` : ""}`);
  }
  return null;
}
