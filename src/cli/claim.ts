// `grayboard claim take|release|watch` and `grayboard whoami`'s handle: a shell
// or script acting as the handle its directory's agent session uses, so a claim
// it takes is held by that session. Results are the claim tools' own JSON.
// Exit 2 when the claim is held by someone else, like `grayboard claims`.
import { existsSync } from "node:fs";
import { ApiError, busMode, loadCredentials, makeClient, signInHint } from "./api.ts";
import { isValidIdentityName } from "../shared/addressing.ts";
import { defaultIdentity, isExplicitIdentity, linkedWorktreeName, pinnedIdentity, resolveIdentity } from "../shared/identity.ts";

export type ClaimTool = "claim_take" | "claim_release" | "claim_watch";

/**
 * The identity this shell acts as, and which rule chose it. `as` is literal:
 * no worktree suffix. A true explicit BUS_IDENTITY (differs from every repo
 * pin) is literal too — the same rule sessions use (src/shared/identity.ts);
 * anything else — no BUS_IDENTITY, or one that merely re-delivers a pin —
 * is derived and keeps the worktree suffix, as sessions do.
 */
export function actingIdentity(as?: string, env = process.env, cwd = process.cwd()): { name: string; source: string } {
  if (as !== undefined) {
    if (!isValidIdentityName(as.toLowerCase())) throw new Error(`invalid --as "${as}": 1–32 chars, a-z 0-9 _ -`);
    return { name: as, source: "--as" };
  }
  if (isExplicitIdentity(env, cwd)) return { name: env.BUS_IDENTITY!, source: "BUS_IDENTITY" };
  const pin = pinnedIdentity(cwd);
  // `||`, not `??`: an empty BUS_IDENTITY falls through to the pin, as in
  // sessionIdentity — with `??` it skipped the pin and changed the handle.
  const base = env.BUS_IDENTITY || pin || defaultIdentity(cwd);
  const rule = pin ? "the repo's .mcp.json pin" : "the directory name";
  const name = resolveIdentity(base, cwd);
  return { name, source: name === base ? rule : `${rule}, plus worktree "${linkedWorktreeName(cwd)}"` };
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
  const { db } = await import("../local/db.ts");
  const { isHuman, lastSeen } = await import("../core/boards.ts");
  const { callBoardTool } = await import("../core/tools.ts");
  const { poke } = await import("../local/wakeup.ts");
  // The human's handle speaks with the human's authority (#announce), which nothing an agent can run may borrow.
  if (isHuman(db, name)) throw new Error(`"${name}" is the human handle; claim commands can't act as it`);
  if (lastSeen(db, name) === null) throw new Error(`no session has used handle "${name}"${hint}`);
  const outcome = callBoardTool(db, name, tool, args);
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
    const { name } = actingIdentity(opts.as);
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
