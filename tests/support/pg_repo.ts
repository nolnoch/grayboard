// A Postgres Repo for tests (#807 P3 C10d2-b), until C11's makePgRepo: the Postgres groups the server's composed paths
// reach (session_end.ts endSessionServer, claims.ts serverClaim and the sweep, board_post.ts systemPost, the
// BoardAccess), on one test database, with the hosted store wired to the composed end through the port it takes in
// production (hosted_port.ts deferredSessionEnd over session_end.ts sessionEndPort). `read` is store A's pool; writes
// go through the caller's Tx (a pgPair side's body), so both sides of a race share it. A group not composed here
// throws when it is reached, naming itself, rather than reading as undefined. `gate` wraps one method of a group so the
// call waits before running, for a race that must hold the composition mid-way.
import type { Repo } from "../../src/server/db.ts";
import { sessionEndPort } from "../../src/server/session_end.ts";
import { makePgAliases } from "../../src/server/store/pg/aliases.ts";
import { makePgAttachments } from "../../src/server/store/pg/attachments.ts";
import { makePgAudit } from "../../src/server/store/pg/audit.ts";
import { makePgBindings } from "../../src/server/store/pg/bindings.ts";
import { makePgBoards } from "../../src/server/store/pg/boards.ts";
import { makePgClaims } from "../../src/server/store/pg/claims.ts";
import { makePgCursors } from "../../src/server/store/pg/cursors.ts";
import { makePgDelegation } from "../../src/server/store/pg/delegation.ts";
import { makePgHosted } from "../../src/server/store/pg/hosted.ts";
import { deferredSessionEnd, noHosted } from "../../src/server/store/pg/hosted_port.ts";
import { makePgIdentity } from "../../src/server/store/pg/identity.ts";
import { makePgMessages } from "../../src/server/store/pg/messages.ts";
import { makePgSessionEnd } from "../../src/server/store/pg/session_end.ts";
import type { SessionEndPort } from "../../src/server/store/session_end.ts";
import { DEFAULT_ATTACHMENT_LIMITS } from "../../src/shared/attachments.ts";
import type { PgPair } from "./pg_race.ts";

export function pgRepo(p: PgPair, clock: () => number = Date.now): Repo {
  const aliases = makePgAliases({ clock });
  let port: SessionEndPort | undefined;
  const groups: Record<string, unknown> = {
    read: p.a.read,
    now: clock,
    aliases,
    bindings: makePgBindings({ clock, aliases }),
    claims: makePgClaims({ clock }),
    boards: makePgBoards({ clock }),
    messages: makePgMessages({ clock, attachmentLimits: DEFAULT_ATTACHMENT_LIMITS }),
    attachments: makePgAttachments(),
    sessionEnd: makePgSessionEnd(),
    delegation: makePgDelegation(),
    cursors: makePgCursors(),
    audit: makePgAudit(),
    hosted: makePgHosted({ sessionEnd: deferredSessionEnd(() => port ??= sessionEndPort("team")(repo)) }),
    ...makePgIdentity({ now: clock, hosted: noHosted }),
  };
  const repo = new Proxy(groups, {
    get(t, k) {
      if (typeof k !== "string" || k in t || k === "then") return t[k as string];
      throw new Error(`pgRepo: no ${k} group (tests/support/pg_repo.ts composes only what the end, claims and posts reach)`);
    },
  }) as unknown as Repo;
  return repo;
}

// Holds `group.method` mid-composition: each call past the first `skip` waits for `open()` before it runs. `reached`
// settles when the first held call arrives. Restore with `undo()`.
export function gate<G extends object, K extends keyof G>(group: G, method: K, skip = 0) {
  const orig = group[method] as unknown as (...a: unknown[]) => Promise<unknown>;
  let calls = 0, opened = false;
  let open!: () => void, hit!: () => void;
  const released = new Promise<void>(r => { open = () => { opened = true; r(); }; });
  const reached = new Promise<void>(r => { hit = r; });
  (group as Record<K, unknown>)[method] = async (...a: unknown[]) => {
    if (calls++ >= skip && !opened) { hit(); await released; }
    return orig.apply(group, a);
  };
  return { reached, open, undo() { (group as Record<K, unknown>)[method] = orig; } };
}
