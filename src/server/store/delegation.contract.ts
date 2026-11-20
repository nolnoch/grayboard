// The delegation store's contract (#807 P3 C10d1, docs/future/postgres-server.md D9): DelegationStore's addressUser and
// facts, over the session end contract's harness (session_end.contract.ts, whose portability rules these rows follow),
// so both stores run the same rows. Registered beside it: db.test.ts for SQLite, pg/session_end.contract.pg.test.ts for
// Postgres. The open cap's lock is a race, so it is Postgres's own test (pg/session_end.pg.test.ts, D1); these rows pin
// what facts reads. Rows moved from db.test.ts's #807 P3 B4b test.
import { expect } from "bun:test";
import { FOREIGN, idsRow, ids, SETTLED, T0, type IdsBackend, type IdsHarness } from "./session_end.contract.ts";
import type { Tx } from "./tx_base.ts";

const B = "b@example.com", C = "c@example.com";

export function delegationContract(backend: IdsBackend): void {
  const it = idsRow(backend);

  it("addressUser: an ID's principal; an alias's holder's, or its last binder's once that session ended; undefined with no session behind it", async h => {
    const { s1, s2, s3, s4 } = ids;
    await h.session(s1, { principal: B });
    await h.session(s2, { principal: C, endedAt: T0 });
    await h.session(s3, { principal: null });
    await h.session(s4, { principal: B });
    for (const a of ["be", "old", "free", "gone"]) await h.alias(`${B}/${a}`);
    await h.hold(`${B}/be`, s1, 1);
    // `old` was last bound by s2, which ended; `free` by s4, which is live and no longer holds it.
    await h.bound(`${B}/old`, s4, 1);
    await h.bound(`${B}/old`, s2, 2);
    await h.bound(`${B}/free`, s4, 3);
    const d = h.delegation;
    expect(await d.addressUser(h.read, s1)).toBe(B);
    expect(await d.addressUser(h.read, s3)).toBeNull();
    expect(await d.addressUser(h.read, `${B}/be`)).toBe(B);
    expect(await d.addressUser(h.read, `${B}/old`)).toBe(C);
    expect(await d.addressUser(h.read, `${B}/free`)).toBeUndefined();
    expect(await d.addressUser(h.read, `${B}/gone`)).toBeUndefined();
    expect(await d.addressUser(h.read, `${B}/none`)).toBeUndefined();
    expect(await d.addressUser(h.read, "id:0000000000099")).toBeUndefined();
  });

  it("facts' launchers: each launcher session's primary hold by address, then unbound launchers by ID; no human, viewer, child, ended or tools-only one", async h => {
    const { s1, s2, s3, s4, s5, s6, s7, s8, s9 } = ids;
    const more = (n: number) => `id:00000000000${n}`;
    // s1: a launcher holding two aliases, listed by its primary (older) one.
    await h.session(s1, { principal: B, launcher: true });
    await h.alias(`${B}/zz`); await h.alias(`${B}/second`);
    await h.hold(`${B}/zz`, s1, 1); await h.hold(`${B}/second`, s1, 2);
    // s2: a launcher holding a human's alias; s3: not a launcher (false), s4 (NULL); both hold an alias.
    await h.session(s2, { principal: B, launcher: true });
    await h.alias(`${B}/human`, { human: true }); await h.hold(`${B}/human`, s2, 1);
    await h.session(s3, { principal: B, launcher: false });
    await h.alias(`${B}/plain`); await h.hold(`${B}/plain`, s3, 1);
    await h.session(s4, { principal: B, launcher: null });
    await h.alias(`${B}/unset`); await h.hold(`${B}/unset`, s4, 1);
    // An offline alias whose last binder, an ended launcher, released it: listed by name.
    await h.session(s5, { principal: C, launcher: true, endedAt: T0 });
    await h.alias(`${C}/offline`); await h.bound(`${C}/offline`, s5, 1);
    // Unbound launchers: s6 is one; s7 a viewer, s8 a child, s9 ended, more(10) tools-only, more(11) not a launcher.
    await h.session(s6, { principal: B, launcher: true });
    await h.session(s7, { principal: B, launcher: true, viewer: true });
    await h.session(s8, { principal: B, launcher: true, rootId: s6 });
    await h.session(s9, { principal: B, launcher: true, endedAt: T0 });
    await h.session(more(10), { principal: B, launcher: true, delivery: "none" });
    await h.session(more(11), { principal: B, launcher: false });
    const f = await h.delegation.facts(h.read, { since: 0 });
    expect(f.launchers()).toEqual([`${B}/zz`, `${C}/offline`, s6]);
    expect(f.launchers().map(l => f.userOf(l))).toEqual([B, C, B]);
    expect(f.launchers().map(l => f.open(l))).toEqual([0, 0, 0]);
    // A named target: isLauncher by the same rules, and only its own facts.
    const named = async (to: string) => { const n = await h.delegation.facts(h.read, { to, since: 0 }); return n.isLauncher(to); };
    expect(await Promise.all([`${B}/zz`, `${B}/second`, `${C}/offline`, s6].map(named))).toEqual([true, true, true, true]);
    expect(await Promise.all([`${B}/human`, `${B}/plain`, `${B}/unset`, s7, s8, s9, more(10), more(11), s1].map(named)))
      .toEqual([false, false, false, false, false, false, false, false, false]);
  });

  it("facts with `to`: whether it connected (an ID with a row, an alias seen) and its user and open count; anything else throws", async h => {
    const { s1 } = ids;
    await h.session(s1, { principal: C, launcher: true });
    await h.alias(`${C}/sim`, { lastSeen: T0 }); await h.hold(`${C}/sim`, s1, 1);
    await h.alias(`${C}/never`);
    const of = (to: string) => h.delegation.facts(h.read, { to, since: 0 });
    const sim = await of(`${C}/sim`);
    expect([sim.everConnected(`${C}/sim`), sim.isLauncher(`${C}/sim`), sim.userOf(`${C}/sim`), sim.open(`${C}/sim`)]).toEqual([true, true, C, 0]);
    expect((await of(s1)).everConnected(s1)).toBe(true);
    expect((await of(`${C}/never`)).everConnected(`${C}/never`)).toBe(false);
    expect((await of(`${C}/none`)).everConnected(`${C}/none`)).toBe(false);
    expect((await of("id:0000000000099")).everConnected("id:0000000000099")).toBe(false);
    expect(() => sim.launchers()).toThrow(/the launcher list was not read/);
    expect(() => sim.open(s1)).toThrow(/the open count of "id:0000000000001" was not read/);
    expect(() => sim.userOf(s1)).toThrow(/the user of "id:0000000000001" was not read/);
    expect(() => sim.everConnected(s1)).toThrow(/whether "id:0000000000001" connected was not read/);
    expect(() => sim.isLauncher(s1)).toThrow(/whether "id:0000000000001" is a launcher was not read/);
    expect(() => sim.humanHandles()).toThrow(/the human handles was not read/);
    expect(() => sim.lastSeen(s1)).toThrow(/a last-seen was not read/);
    const auto = await h.delegation.facts(h.read, { since: 0 });
    expect(() => auto.everConnected(`${C}/sim`)).toThrow(/was not read/);
    expect(() => auto.userOf(`${C}/never`)).toThrow(/the user of "c@example.com\/never" was not read/);
  });

  it("facts' open count: requests to the target since `since` whose message exists and that its side hasn't replied to or acked", async h => {
    const { s1, s2 } = ids;
    const L = `${B}/launcher`, OTHER = `${B}/other`, REQ = `${C}/req`;
    await h.session(s1, { principal: B, launcher: true });
    await h.session(s2, { principal: B, launcher: true });
    await h.alias(L); await h.hold(L, s1, 1);
    await h.alias(OTHER); await h.hold(OTHER, s2, 1);
    const request = async (at: number, to = L, target = to) => { const m = await h.message(REQ, to); await h.requested(target, at, m); return m; };
    // Counted: a plain request; one the requester itself replied to; one the requester acked.
    await request(T0 + 1);
    const selfReplied = await request(T0 + 2);
    await h.message(REQ, L, selfReplied);
    const selfAcked = await request(T0 + 3);
    await h.ack(REQ, selfAcked);
    // Not counted: taken by a reply from the launcher's side, or its ack; at or before `since`; a message gone (an id
    // with no row); a message to another recipient than the audited target.
    const replied = await request(T0 + 4);
    await h.message(L, REQ, replied);
    const acked = await request(T0 + 5);
    await h.ack(L, acked);
    await request(T0);
    await h.requested(L, T0 + 6, 999_999);
    await request(T0 + 7, OTHER, L);
    // Another launcher's request counts for it alone.
    await request(T0 + 8, OTHER);
    const auto = await h.delegation.facts(h.read, { since: T0 });
    expect([auto.open(L), auto.open(OTHER)]).toEqual([3, 1]);
    expect((await h.delegation.facts(h.read, { to: L, since: T0 })).open(L)).toBe(3);
    expect((await h.delegation.facts(h.read, { to: L, since: T0 - 1 })).open(L)).toBe(4);
    expect((await h.delegation.facts(h.read, { to: L, since: T0 + 3 })).open(L)).toBe(0);
  });

  it("facts and addressUser run on the Tx they're given (a body's own writes) and refuse a settled Tx and another backend's handle", async h => {
    await h.session(ids.s1, { principal: B, launcher: true });
    const d = h.delegation;
    const kept = await h.write(async tx => {
      expect((await d.facts(tx, { since: 0 })).launchers()).toEqual([ids.s1]);
      expect(await d.addressUser(tx, ids.s1)).toBe(B);
      return tx;
    });
    await expect(d.addressUser(kept, ids.s1)).rejects.toThrow(SETTLED);
    await expect(d.facts(kept, { since: 0 })).rejects.toThrow(SETTLED);
    await expect(d.facts({} as Tx, { since: 0 })).rejects.toThrow(FOREIGN);
    await expect(d.addressUser({} as Tx, ids.s1)).rejects.toThrow(FOREIGN);
  });
}

export type { IdsHarness };
