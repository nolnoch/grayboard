// `grayboard claim take|release|watch` and `grayboard whoami`'s handle: a shell
// or script acting as the handle its agent session uses, so a claim it takes
// is held by that session. Results are the claim tools' own JSON.
// Exit 2 when the claim is held by someone else, like `grayboard claims`.
import { existsSync, realpathSync } from "node:fs";
import { ApiError, busMode, loadCredentials, makeClient, signInHint } from "./api.ts";
import { normalizeIdentityName } from "../shared/addressing.ts";
import { defaultIdentity, gitLocation, isExplicitIdentity, linkedWorktreeName, pinnedIdentity, resolveIdentity } from "../shared/identity.ts";

export type ClaimTool = "claim_take" | "claim_release" | "claim_watch";

/** A live local session, as its bindings row records it (src/local/binding.ts). */
export type LiveSession = { name: string | null; harness_pid: number | null; cwd: string | null };

/** The local sessions alive now and this process's ancestors: what decides a local shell's name. */
export type LocalView = { sessions: LiveSession[]; ancestors: number[] };

// The checkout `cwd` is in: the repo plus its linked worktree, or the
// directory itself outside git.
function checkoutOf(cwd: string): string {
  const loc = gitLocation(cwd);
  if (loc) return loc.worktree ? `${loc.repo}\0${loc.worktree}` : loc.repo;
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * The live session this shell belongs to (#182 decision 18): the one whose
 * harness is an ancestor of this process, else the one in this checkout. One
 * harness can host several sessions (a launcher, a test runner); the checkout
 * narrows those. None, several, or an unbound one refuses, pointing at --as:
 * a claim on a guessed name would land on the wrong handle silently.
 */
export function boundSession(view: LocalView, cwd: string): { name: string; source: string } {
  const here = checkoutOf(cwd);
  const inHere = (r: LiveSession) => r.cwd !== null && checkoutOf(r.cwd) === here;
  const mine = new Set(view.ancestors);
  const under = view.sessions.filter((r) => r.harness_pid !== null && mine.has(r.harness_pid));
  const pick = under.length > 1 ? under.filter(inHere) : under.length ? under : view.sessions.filter(inHere);
  const source = under.length ? "the session this shell runs under" : "the session in this checkout";
  if (pick.length === 0 && under.length > 1) {
    throw new Error(`${under.length} live sessions run this shell (${under.map((r) => r.name ?? "an unbound session").join(", ")}), none in this checkout; pass --as <name>`);
  }
  if (pick.length === 0) throw new Error("no live session runs this shell or this checkout; pass --as <name>");
  if (pick.length > 1) {
    const names = pick.map((r) => r.name ?? "an unbound session").join(", ");
    throw new Error(`${pick.length} live sessions could own this shell (${names}); pass --as <name>`);
  }
  const name = pick[0]!.name;
  if (!name) throw new Error(`${source} hasn't bound a name yet; bind one there, or pass --as <name>`);
  return { name, source };
}

/**
 * The identity this shell acts as, and which rule chose it. `as` is literal:
 * no worktree suffix. A true explicit BUS_IDENTITY (differs from every repo
 * pin) is literal too — the same rule sessions use (src/shared/identity.ts).
 * Otherwise, in local mode (`local` given), the live session this shell
 * belongs to, since sessions bind their names (#182). Server mode has no
 * local rows, so it keeps the derived rule: no BUS_IDENTITY, or one that
 * merely re-delivers a pin, keeps the worktree suffix, as sessions did.
 */
export function actingIdentity(as?: string, env = process.env, cwd = process.cwd(), local?: LocalView): { name: string; source: string } {
  if (as !== undefined) {
    // Same rule the session itself resolves by (#181): lowercased, then
    // validated — so --as Gray acts as "gray", the handle both modes agree on.
    const n = normalizeIdentityName(as);
    if (!n.ok) throw new Error(`invalid --as "${as}": 1–32 chars, a-z 0-9 _ -`);
    return { name: n.name, source: "--as" };
  }
  if (isExplicitIdentity(env, cwd)) {
    const n = normalizeIdentityName(env.BUS_IDENTITY!);
    if (!n.ok) throw new Error(n.error);
    return { name: n.name, source: "BUS_IDENTITY" };
  }
  if (local) return boundSession(local, cwd);
  const pin = pinnedIdentity(cwd);
  // `||`, not `??`: an empty BUS_IDENTITY falls through to the pin, as in
  // sessionIdentity — with `??` it skipped the pin and changed the handle.
  const base = env.BUS_IDENTITY || pin || defaultIdentity(cwd);
  const rule = pin ? "the repo's .mcp.json pin" : "the directory name";
  const name = resolveIdentity(base, cwd);
  return { name, source: name === base ? rule : `${rule}, plus worktree "${linkedWorktreeName(cwd)}"` };
}

// The local bus's live sessions; none when no session has created the bus.
async function localView(): Promise<LocalView> {
  const { ancestors } = await import("../shared/proc.ts");
  const { localDbPath, openLocalDb } = await import("../local/open.ts");
  if (!existsSync(localDbPath())) return { sessions: [], ancestors: ancestors() };
  const { deliverEnded } = await import("../local/wakeup.ts");
  const { db, ended, live } = openLocalDb();
  try {
    await deliverEnded(db, ended);
    return { sessions: live, ancestors: ancestors() };
  } finally {
    db.close();
  }
}

/** actingIdentity for this process, reading the local bus's sessions when the rule needs them. */
export async function actingName(as?: string, mode = busMode()): Promise<{ name: string; source: string }> {
  const needsLocal = mode === "local" && as === undefined && !isExplicitIdentity();
  return actingIdentity(as, process.env, process.cwd(), needsLocal ? await localView() : undefined);
}

/** The bus handle for `name`: as-is in local mode, `<email>/<name>` (lowercased, as the server stores it) in server mode. */
export function busHandle(name: string, mode = busMode()): string {
  if (mode === "local") return name;
  const email = loadCredentials()?.user_email;
  if (!email) throw new Error("signed out; run grayboard login");
  return `${email}/${name.toLowerCase()}`;
}

async function localCall(name: string, tool: ClaimTool, args: Record<string, unknown>): Promise<unknown> {
  const { localDbPath } = await import("../local/open.ts");
  const hint = `; check which handle this shell acts as with grayboard whoami, or pass --as`;
  if (!existsSync(localDbPath())) throw new Error(`no session has used handle "${name}"${hint}`);
  const { db, openEnded } = await import("../local/db.ts");
  const { isHuman, lastSeen } = await import("../core/boards.ts");
  const { callBoardTool } = await import("../core/tools.ts");
  const { holderOf } = await import("../core/bindings.ts");
  const { deliverEnded, poke } = await import("../local/wakeup.ts");
  await deliverEnded(db, openEnded);
  // The human's handle speaks with the human's authority (#announce), which nothing an agent can run may borrow.
  if (isHuman(db, name)) throw new Error(`"${name}" is the human handle; claim commands can't act as it`);
  if (lastSeen(db, name) === null) throw new Error(`no session has used handle "${name}"${hint}`);
  // As the session holding the name: its address set, so a claim it took
  // under its ID before binding is its own here too (#284 S5). No `session`:
  // this process wrote the post, not that session.
  const holder = holderOf(db, name);
  const outcome = callBoardTool(db, name, tool, args, { addresses: holder ? [name, holder] : [name] });
  // The acting session too: a wakeup re-arms its claim-expiry timer, as its own tool call would.
  await Promise.all([...new Set([...outcome.wake, name])].map((h) => poke(h)));
  return outcome.result;
}

async function serverCall(name: string, tool: ClaimTool, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await makeClient().post("/api/claims/call", { identity: name, tool, args });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // An unknown identity is "unknown_identity"; a bare not_found means the route itself is missing.
    if (e.code === "not_found") throw new Error("this server predates grayboard claim; update the server");
    if (e.status === 401) throw new Error(signInHint(loadCredentials()?.server));
    throw new Error(`${e.message} (${e.code})`);
  }
}

export async function runClaimTool(tool: ClaimTool, args: Record<string, unknown>, opts: { as?: string; json?: boolean }): Promise<number> {
  let result: unknown;
  try {
    const mode = busMode();
    const { name } = await actingName(opts.as, mode);
    result = mode === "server" ? await serverCall(name, tool, args) : await localCall(name, tool, args);
  } catch (e) {
    console.error(`[grayboard] ${tool.replace("_", " ")}: ${(e as Error).message}`);
    return 1;
  }
  const held = typeof result === "object" && result !== null && (result as { ok?: boolean }).ok === false;
  if (opts.json || typeof result !== "string") console.log(JSON.stringify(result, null, 2));
  else console.log(result);
  return held ? 2 : 0;
}
