// `grayboard claims`: active claims for a shell or a harness hook, which can't
// call MCP tools. Exit 2 when another session holds a match, so a Claude Code
// PreToolUse hook blocks the tool call and shows Claude why; 0 when none; 1 on
// grayboard's own error, which a hook treats as non-blocking (fails open).
import { existsSync } from "node:fs";
import { busMode, loadCredentials, makeClient } from "./api.ts";
import { sessionIdentity } from "../shared/identity.ts";

export type ListedClaim = { key: string; holder: string; note: string | null; acquired_at: number; expires_at: number };

// Local mode reads the bus file directly; it never creates one.
async function localClaims(prefix: string | undefined): Promise<ListedClaim[]> {
  const { localDbPath, openLocalDb } = await import("../local/open.ts");
  if (!existsSync(localDbPath())) return [];
  const { listClaims } = await import("../core/claims.ts");
  const db = openLocalDb();
  try {
    return listClaims(db, prefix).map(({ board: _b, ...c }) => c);
  } finally {
    db.close();
  }
}

async function serverClaims(prefix: string | undefined): Promise<ListedClaim[]> {
  const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
  return (await makeClient().get(`/api/claims${q}`)) as ListedClaim[];
}

// This session's handle, as the bus names it, or undefined if it can't be told.
function self(mode: "local" | "server"): string | undefined {
  try {
    const name = sessionIdentity();
    if (mode === "local") return name;
    const email = loadCredentials()?.user_email;
    return email ? `${email}/${name.toLowerCase()}` : undefined;
  } catch {
    return undefined;
  }
}

export function formatClaim(c: ListedClaim): string {
  const until = new Date(c.expires_at).toISOString().slice(0, 16);
  return `${c.key} held by ${c.holder} until ${until}Z${c.note ? `: ${c.note}` : ""}`;
}

export async function runClaims(opts: { prefix?: string; json?: boolean; includeSelf?: boolean }): Promise<number> {
  const mode = busMode();
  let claims: ListedClaim[];
  try {
    claims = mode === "server" ? await serverClaims(opts.prefix) : await localClaims(opts.prefix);
  } catch (e) {
    console.error(`[grayboard] claims: ${(e as Error).message}`);
    return 1;
  }
  const me = opts.includeSelf ? undefined : self(mode);
  const held = me ? claims.filter((c) => c.holder !== me) : claims;
  if (opts.json) console.log(JSON.stringify(held, null, 2));
  else if (held.length) console.error(["Active claims; check with the holder before going ahead:", ...held.map(formatClaim)].join("\n"));
  else console.log("no active claims");
  return held.length ? 2 : 0;
}
