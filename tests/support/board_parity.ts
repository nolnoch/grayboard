// The server's board parity fixture (#807 P3 B5a0, B5b1b1): four users, two teams of different policies, person and
// team aliases, a live and an ended session ID, a live one bound to a team's name (#1273 L4), a tools-only one writing
// as a team's name, and a service one user may invoke (#1286). The async board access and the ported board tools are each compared
// against core run over it with the synchronous access oracle (tests/support/sync_access.ts; src/server/board-access-parity.test.ts,
// board-tools-parity.test.ts).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idAddress } from "../../src/core/bindings.ts";
import { insertUpload } from "../../src/core/attachments.ts";
import { holdAlias } from "../../src/core/bindings.ts";
import { archiveBoard, createBoard, markHuman, muteThread, post, registerId, setAccess, setSubscription, subscribe, touchAlias, type Board, type CoreDb } from "../../src/core/boards.ts";
import type { AliasScopeOf } from "../../src/server/access.ts";
import { openDatabase, type Repo } from "../../src/server/db.ts";
import type { Read, Tx } from "../../src/server/store/tx.ts";
import { scratchDbPath } from "./scratch_db.ts";
import { seed } from "./seed.ts";
import { serverAccess } from "./sync_access.ts";
import { grantOwner } from "./roles.ts";

export const person = (email: string, name: string) => ({ scope_kind: "person" as const, scope_ref: email, name });
export const team = (ref: string, name: string) => ({ scope_kind: "team" as const, scope_ref: ref, name });
export const board = (name: string, scope: string | null): Board => ({ name, purpose: "", scope, created_by: "x", created_at: 0 });

export const BOARDS = [board("general", null), board("eng", "team:eng"), board("ops", "team:ops"), board("odd", "weird")];
export const WADE_ID = idAddress("a".repeat(64));
export const ENDED_ID = idAddress("b".repeat(64));
// wade's session bound only to `eng/build`: on a scoped board it acts as eng, not as wade (#1255), so it doesn't see
// ops's board though wade does.
export const ENG_ID = idAddress("7".repeat(64));
// wade's tools-only session writing as eng/deploy, holding nothing: an ID with no primary is judged as its writes_as
// name (seer's fallback), so it doesn't see ops's board either. On svc's names (seer's service branch) ENG_ID is
// judged as eng, which holds no service_invoke on svc, though wade does (#1286).
export const TOOLS_ID = idAddress("6".repeat(64));
export const W = "wade@example.com", B = "bob@example.com", E = "eve@example.com", D = "dan@example.com";
export const HANDLES = [`${W}/be`, `${B}/be`, `${B}/qa`, `${E}/be`, `${D}/be`, "eng/deploy", "ops/deploy", "team:eng", WADE_ID, ENDED_ID, ENG_ID, TOOLS_ID, "nobody@example.com/be", "be", ""];
export const SCOPES: AliasScopeOf[] = [
  { scope_kind: "person", scope_ref: W }, { scope_kind: "person", scope_ref: null }, { scope_kind: "team", scope_ref: "eng" },
  { scope_kind: "team", scope_ref: "ops" }, { scope_kind: "team", scope_ref: "nope" }, { scope_kind: "team", scope_ref: null },
  { scope_kind: "service", scope_ref: "svc" },
];
export const TOKENS = [`${B}/qa`, `${B}/human`, `${D}/human`, "eng/deploy", "be", "qa", "deploy", "human", "team:eng", WADE_ID, ENDED_ID, idAddress("f".repeat(64)), "nope", "!!", "eng/ghost", `${B}/ghost`];
export const AUTHORS = [`${W}/be`, `${B}/be`, `${E}/be`, `${D}/be`, WADE_ID, "eng/deploy", "eng/other"];

/**
 * A fresh server database holding the fixture: wade owns eng (collaborative, bob a member) and is a member of ops
 * (delegating, owned by eve); dan is in neither. WADE_ID is wade's live session, ENDED_ID bob's ended one, ENG_ID wade's
 * session holding only eng/build, TOOLS_ID wade's tools-only session writing as eng/deploy. Service svc's
 * service_invoke is wade's own.
 */
export async function openBoardParity(): Promise<{ repo: Repo; db: CoreDb }> {
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  // Core's functions run over this database as the oracle the server's ports are compared against: the synchronous
  // access the server installed until #807 P3 C10d2-a (tests/support/sync_access.ts).
  setAccess(db, serverAccess(repo, db));
  await seed(repo, async tx => {
    const [wade, bob, eve] = [await repo.users.upsertByEmail(tx, W, null), await repo.users.upsertByEmail(tx, B, null), await repo.users.upsertByEmail(tx, E, null)];
    await repo.users.upsertByEmail(tx, D, null);
    const eng = await repo.teams.create(tx, "eng", wade.id);
    await repo.teams.addMember(tx, eng.id, wade.id);
    await grantOwner(repo, tx, "eng", W);
    await repo.teams.addMember(tx, eng.id, bob.id);
    await repo.teams.setPolicy(tx, eng.id, "collaborative");
    const ops = await repo.teams.create(tx, "ops", eve.id);
    await repo.teams.addMember(tx, ops.id, eve.id);
    await grantOwner(repo, tx, "ops", E);
    await repo.teams.addMember(tx, ops.id, wade.id);
    await repo.teams.setPolicy(tx, ops.id, "delegating");
    for (const [email, name] of [[W, "be"], [B, "be"], [B, "qa"], [B, "human"], [E, "be"], [D, "be"], [D, "human"]] as const) await repo.aliases.create(tx, person(email, name), email);
    await repo.aliases.create(tx, team("eng", "deploy"), W);
    await repo.aliases.create(tx, team("ops", "deploy"), E);
    registerId(repo.coreOn(tx), { id: WADE_ID, principal: W, launcher: false });
    registerId(repo.coreOn(tx), { id: ENDED_ID, principal: B, launcher: false });
    await repo.aliases.create(tx, team("eng", "build"), W);
    registerId(repo.coreOn(tx), { id: ENG_ID, principal: W, launcher: false });
    holdAlias(repo.coreOn(tx), "eng/build", ENG_ID, 1);
    registerId(repo.coreOn(tx), { id: TOOLS_ID, principal: W, launcher: false, writesAs: "eng/deploy" });
    await repo.services.create(tx, "svc");
    repo.coreOn(tx).prepare(`INSERT INTO role_bindings (principal_id, role, scope_id, granted_by, granted_at)
      SELECT h.id, 'service_invoke', s.id, NULL, 0 FROM principals h, principals s WHERE h.name = ? AND s.name = 'svc'`).run(W);
  });
  // Its row only: it holds, owns and was sent nothing.
  await seed(repo, tx => repo.sessionEnd.end(tx, ENDED_ID, 5));
  return { repo, db };
}

export const BOB_ID = idAddress("c".repeat(64)), EVE_ID = idAddress("d".repeat(64)), TAIL_ID = idAddress("e".repeat(64));
export const DAN_WRITER = idAddress("8".repeat(64)), CHILD_ID = idAddress("5".repeat(64)), UNKNOWN_ID = idAddress("f".repeat(64));
export const ONLINE = new Set([`${W}/be`, "eng/deploy", `${E}/be`, "ops/deploy", `${B}/be`, WADE_ID]);

/** The post fixture's ids and the time it was written by (`T1`: anything later is the call's). */
export type PostParity = {
  repo: Repo; db: CoreDb; T1: number;
  ROOT: number; REPLY: number; PLAN: number; ATTIC: number; QPOST: number; QLATE: number; UP_W: number; UP_W2: number; UP_B: number;
};

/**
 * openBoardParity extended for the ported writes (#807 P3 B5b2b, B5b3): live sessions and holds, a muted thread, a
 * thread a human wrote in, an archived board `attic`, a queue board `q` with lanes (a viewer's and an opted-out one
 * among them), a held queue claim and one since deleted, a team queue board, and uploads.
 */
export async function openPostParity(): Promise<PostParity> {
  const { repo, db } = await openBoardParity();
  let ROOT = 0, REPLY = 0, PLAN = 0, ATTIC = 0, QPOST = 0, QLATE = 0, UP_W = 0, UP_W2 = 0, UP_B = 0;
  const T0 = Date.now() - 600_000;
  await seed(repo, async tx => {
    const core = repo.coreOn(tx);
    registerId(core, { id: BOB_ID, principal: B, launcher: false });
    registerId(core, { id: EVE_ID, principal: E, launcher: false });
    registerId(core, { id: TAIL_ID, principal: W, launcher: false, viewer: true });
    registerId(core, { id: DAN_WRITER, principal: D, launcher: false, writesAs: `${B}/be` });
    registerId(core, { id: CHILD_ID, principal: W, launcher: false, rootId: WADE_ID });
    const holds: [string, string][] = [[`${W}/be`, WADE_ID], ["eng/deploy", WADE_ID], [`${B}/be`, BOB_ID], [`${B}/qa`, BOB_ID], [`${E}/be`, EVE_ID], ["ops/deploy", EVE_ID]];
    for (const [address, id] of holds) { holdAlias(core, address, id, T0); touchAlias(core, address, T0); }
    touchAlias(core, `${D}/be`, T0);
    core.prepare(`UPDATE aliases SET queue_off = 1 WHERE address = ?`).run(`${B}/qa`);
    markHuman(core, `${B}/human`, true);
    createBoard(core, `${W}/be`, "general", "everyone");
    createBoard(core, `${W}/be`, "eng", "eng work", "team:eng");
    createBoard(core, `${E}/be`, "ops", "ops work", "team:ops");
    subscribe(core, `${B}/qa`, "general", "push");
    subscribe(core, `${E}/be`, "general", "digest");
    subscribe(core, `${D}/be`, "general", "push");
    subscribe(core, TAIL_ID, "general", "push");
    subscribe(core, `${B}/be`, "eng", "push");
    // A subscription left by sight since lost (dan was never in eng): judged on the post, never pushed.
    setSubscription(core, `${D}/be`, "eng", "push");
    subscribe(core, `${W}/be`, "ops", "digest");
    // A thread wade wrote in and muted: a reply reaches its other authors but not him, short of a mention.
    ROOT = post(core, `${B}/be`, "general", "thread root").post.id;
    REPLY = post(core, `${E}/be`, "general", "a reply", ROOT).post.id;
    post(core, `${W}/be`, "general", "me too", ROOT);
    muteThread(core, `${W}/be`, "general", ROOT, true);
    // bob's human wrote in it too: neither parent nor root author, so only the human mark wakes it on a reply.
    post(core, `${B}/human`, "general", "human weighs in", ROOT);
    PLAN = post(core, `${W}/be`, "eng", "eng plan").post.id;
    createBoard(core, `${W}/be`, "attic", "old");
    ATTIC = post(core, `${W}/be`, "attic", "last").post.id;
    archiveBoard(core, `${W}/be`, "attic", true);
    // A queue board: wade made it; bob's be and qa (opted out), eve, deploy, dan and wade's viewer tail are lanes.
    createBoard(core, `${W}/be`, "q", "work", null, { kind: "queue" });
    for (const lane of [`${B}/be`, `${B}/qa`, `${E}/be`, "eng/deploy", `${D}/be`, TAIL_ID]) subscribe(core, lane, "q", "push");
    // A team queue board, so a mention of a non-member is judged on a queue too.
    createBoard(core, `${W}/be`, "engq", "eng work", "team:eng", { kind: "queue" });
    subscribe(core, `${B}/be`, "engq", "push");
    // eve hands a post to bob's be (a mention claim he holds) and another whose claim has since gone, then rotates one
    // to the live, never-woken eng/deploy: a later rotation prefers the lanes never woken.
    // An author's own words (strictIds), as a board_post is: only those hand a mention a claim (#219).
    QPOST = post(core, `${E}/be`, "q", `@${B}/be please`, null, { strictIds: true }).post.id;
    QLATE = post(core, `${E}/be`, "q", `@${B}/be also`, null, { strictIds: true }).post.id;
    core.prepare(`DELETE FROM claims WHERE key = ?`).run(`queue:q:${QLATE}`);
    post(core, `${E}/be`, "q", "deploy it", null, { strictIds: true, online: h => ONLINE.has(h) });
    // A claim watcher on bob's held key: an ack ends the claim, and the watch with it.
    core.prepare(`INSERT INTO claim_watches (key, handle) VALUES (?, ?)`).run(`queue:q:${QPOST}`, `${E}/be`);
    const up = (uploader: string, principal: string, name: string) =>
      insertUpload(core, { sha256: name.padEnd(64, "0"), filename: `${name}.txt`, type: "text/plain", size: 10, uploader, quota: { principal, unsent: 1e9, stored: 1e9 }, now: T0 }).row.id;
    UP_W = up(`${W}/be`, W, "a");
    UP_W2 = up("eng/deploy", W, "b");
    UP_B = up(`${B}/be`, B, "c");
  });
  const T1 = Date.now();
  while (Date.now() <= T1) { /* the next millisecond */ }
  return { repo, db, T1, ROOT, REPLY, PLAN, ATTIC, QPOST, QLATE, UP_W, UP_W2, UP_B };
}

export const outcome = <T>(f: () => T): { value: T } | { error: string; code?: string } => {
  try { return { value: f() }; } catch (e) { return refused(e); }
};
export const outcomeAsync = async <T>(f: () => Promise<T>): Promise<{ value: T } | { error: string; code?: string }> => {
  try { return { value: await f() }; } catch (e) { return refused(e); }
};
// A refusal's text and class: core's CoreError or an Undeliverable's code must survive the port.
export const refused = (e: unknown) => {
  const err = e as Error & { code?: string };
  return { error: `${err.constructor.name}: ${err.message}`, ...(err.code ? { code: err.code } : {}) };
};

// The rows board_post writes, every time a call set reduced to "now".
export const parityRows = (repo: Repo, tx: Read) => {
  const c = repo.coreOn(tx);
  return {
    posts: c.prepare(`SELECT * FROM posts ORDER BY id`).all(),
    outbox: c.prepare(`SELECT * FROM outbox ORDER BY handle, post_id`).all(),
    claims: c.prepare(`SELECT * FROM claims ORDER BY key`).all(),
    claim_events: c.prepare(`SELECT * FROM claim_events ORDER BY id`).all(),
    claim_watches: c.prepare(`SELECT * FROM claim_watches ORDER BY key, handle`).all(),
    subscriptions: c.prepare(`SELECT board, handle, mode, cursor, notified_id FROM subscriptions ORDER BY board, handle`).all(),
    attachments: c.prepare(`SELECT id, post_id, message_id FROM attachments ORDER BY id`).all(),
  };
};
const TIMES = new Set(["created_at", "acquired_at", "expires_at", "at", "delivered_at"]);
// An expiry past T1 keeps its distance from T1 in whole minutes, so a port that drops a renewal's ttl_minutes or until shows (#1230).
const settled = (T1: number, v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (TIMES.has(k) && typeof x === "number" && x > T1 ? (k === "expires_at" ? `later+${Math.round((x - T1) / 60_000)}m` : "now") : x)));

class Rollback { constructor(readonly value: unknown) {} }
/** f's answer and the rows it left, in a write body rolled back after; times past `T1` settle to "now" or "later+<minutes>m". */
export async function inBody(repo: Repo, T1: number, f: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  try { await repo.write(async tx => { throw new Rollback({ out: await f(tx), rows: parityRows(repo, tx) }); }); }
  catch (e) { if (e instanceof Rollback) return settled(T1, e.value); throw e; }
  throw new Error("unreachable");
}
// Each diverging call with only the parts that differ: its answer, or the tables whose rows differ.
export const diverging = (rs: [string, unknown, unknown][]) => rs.filter(([, s, a]) => JSON.stringify(s) !== JSON.stringify(a)).map(([l, s, a]) => {
  const [w, g] = [s, a] as { out: unknown; rows: Record<string, unknown> }[];
  const d: Record<string, unknown> = { l };
  if (JSON.stringify(w!.out) !== JSON.stringify(g!.out)) Object.assign(d, { core: w!.out, port: g!.out });
  for (const t of Object.keys(w!.rows)) {
    const [cw, cg] = [w!.rows[t] as unknown[], g!.rows[t] as unknown[]];
    const differs = (x: unknown[], y: unknown[]) => x.filter((r, i) => JSON.stringify(r) !== JSON.stringify(y[i]));
    if (JSON.stringify(cw) !== JSON.stringify(cg)) d[t] = { core: differs(cw, cg), port: differs(cg, cw) };
  }
  return d;
});
