// The server's board parity fixture (#807 P3 B5a0, B5b1b1): four users, two teams of different policies, person and
// team aliases, a live and an ended session ID. The async board access and the ported board tools are each compared
// against the sync seam core still runs over it (src/server/board-access-parity.test.ts, board-tools-parity.test.ts).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idAddress } from "../../src/core/bindings.ts";
import { registerId, type Board, type CoreDb } from "../../src/core/boards.ts";
import type { AliasScopeOf } from "../../src/server/access.ts";
import { openDatabase, type Repo } from "../../src/server/db.ts";
import { scratchDbPath } from "./scratch_db.ts";
import { seed } from "./seed.ts";

export const person = (email: string, name: string) => ({ scope_kind: "person" as const, scope_ref: email, name });
export const team = (ref: string, name: string) => ({ scope_kind: "team" as const, scope_ref: ref, name });
export const board = (name: string, scope: string | null): Board => ({ name, purpose: "", scope, created_by: "x", created_at: 0 });

export const BOARDS = [board("general", null), board("eng", "team:eng"), board("ops", "team:ops"), board("odd", "weird")];
export const WADE_ID = idAddress("a".repeat(64));
export const ENDED_ID = idAddress("b".repeat(64));
export const W = "wade@example.com", B = "bob@example.com", E = "eve@example.com", D = "dan@example.com";
export const HANDLES = [`${W}/be`, `${B}/be`, `${B}/qa`, `${E}/be`, `${D}/be`, "eng/deploy", "ops/deploy", "team:eng", WADE_ID, ENDED_ID, "nobody@example.com/be", "be", ""];
export const SCOPES: AliasScopeOf[] = [
  { scope_kind: "person", scope_ref: W }, { scope_kind: "person", scope_ref: null }, { scope_kind: "team", scope_ref: "eng" },
  { scope_kind: "team", scope_ref: "ops" }, { scope_kind: "team", scope_ref: "nope" }, { scope_kind: "team", scope_ref: null },
  { scope_kind: "service", scope_ref: "svc" },
];
export const TOKENS = [`${B}/qa`, `${B}/human`, `${D}/human`, "eng/deploy", "be", "qa", "deploy", "human", "team:eng", WADE_ID, ENDED_ID, idAddress("f".repeat(64)), "nope", "!!", "eng/ghost", `${B}/ghost`];
export const AUTHORS = [`${W}/be`, `${B}/be`, `${E}/be`, `${D}/be`, WADE_ID, "eng/deploy", "eng/other"];

/**
 * A fresh server database holding the fixture: wade owns eng (collaborative, bob a member) and is a member of ops
 * (delegating, owned by eve); dan is in neither. WADE_ID is wade's live session, ENDED_ID bob's ended one.
 */
export async function openBoardParity(): Promise<{ repo: Repo; db: CoreDb }> {
  const { repo, db } = openDatabase(scratchDbPath(), { blobDir: mkdtempSync(join(tmpdir(), "gb-blobs-")) });
  await seed(repo, async tx => {
    const [wade, bob, eve] = [await repo.users.upsertByEmail(tx, W, null), await repo.users.upsertByEmail(tx, B, null), await repo.users.upsertByEmail(tx, E, null)];
    await repo.users.upsertByEmail(tx, D, null);
    const eng = await repo.teams.create(tx, "eng", wade.id);
    await repo.teams.addMember(tx, eng.id, wade.id, "owner");
    await repo.teams.addMember(tx, eng.id, bob.id);
    await repo.teams.setPolicy(tx, eng.id, "collaborative");
    const ops = await repo.teams.create(tx, "ops", eve.id);
    await repo.teams.addMember(tx, ops.id, eve.id, "owner");
    await repo.teams.addMember(tx, ops.id, wade.id);
    await repo.teams.setPolicy(tx, ops.id, "delegating");
    for (const [email, name] of [[W, "be"], [B, "be"], [B, "qa"], [B, "human"], [E, "be"], [D, "be"], [D, "human"]] as const) await repo.aliases.create(tx, person(email, name), email);
    await repo.aliases.create(tx, team("eng", "deploy"), W);
    await repo.aliases.create(tx, team("ops", "deploy"), E);
    registerId(repo.coreOn(tx), { id: WADE_ID, principal: W, launcher: false });
    registerId(repo.coreOn(tx), { id: ENDED_ID, principal: B, launcher: false });
  });
  await seed(repo, tx => repo.sessionEnd.end(tx, ENDED_ID, { why: "test", now: 5 }));
  return { repo, db };
}
