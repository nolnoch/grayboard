// The name record (#182 decision 14): `bind.<harness pid>` in the bus's
// socket directory, written by the process that owns delivery whenever its
// names change (every name it holds, oldest first; none while unbound). A
// grayboard mcp restarted under the same harness process (`/mcp` reconnect, a
// crash) finds it and takes the names back, so a session that bound names
// mid-task doesn't come back unbound. A record whose harness has exited, or whose pid now belongs
// to another process, is stale: it's deleted, never honoured.
//
// The file is writable by any process running as the user, the same trust
// domain as the wakeup sockets beside it.
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { procStart, procStarts } from "./proc.ts";
import { asSessionId } from "../core/bindings.ts";

export type NameRecord = {
  // Every name the session holds, oldest first (#284 S10); empty while unbound.
  names: string[];
  // The session that wrote it, for the binding history: an `id:` address. A
  // 1.x record's 16-hex ID is re-encoded on read (the same 64 bits), so a
  // restart across the upgrade still matches its history.
  session_id: string;
  harness_pid: number;
  // The harness's start time (procStart): a reused pid doesn't match.
  harness_start: string;
  // Which bus the name is on: the local database path, or the server URL. A
  // record for another bus is left alone.
  bus: string;
  at: number;
};

const PREFIX = "bind.";

export function recordPath(dir: string, harnessPid: number): string {
  return join(dir, `${PREFIX}${harnessPid}`);
}

/**
 * Record this session's name for its harness. Written to a temp file and
 * renamed, so a reader never sees half a record. Null if the harness's start
 * time can't be read (the record could never be checked, so none is written).
 */
export function writeRecord(dir: string, r: Omit<NameRecord, "harness_start" | "at">, now = Date.now()): NameRecord | null {
  const harness_start = procStart(r.harness_pid);
  if (!harness_start) {
    console.error(`[grayboard] can't read harness pid ${r.harness_pid}'s start time; no name record written, so a restart comes back unbound`);
    return null;
  }
  const rec: NameRecord = { ...r, harness_start, at: now };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${recordPath(dir, r.harness_pid)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, recordPath(dir, r.harness_pid));
  return rec;
}

// A record from before #284 PR 4 carries one `name` (a string, or null while
// unbound): read as that one-name list. Client files can't be migrated.
function parse(text: string): NameRecord | null {
  try {
    const { name, ...r } = JSON.parse(text) as NameRecord & { name?: unknown };
    if (typeof r.harness_pid !== "number" || typeof r.harness_start !== "string" || typeof r.bus !== "string") return null;
    if (r.names === undefined) {
      if (name !== null && typeof name !== "string") return null;
      return { ...r, names: name === null ? [] : [name] };
    }
    if (!Array.isArray(r.names) || !r.names.every((n) => typeof n === "string")) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * The record for `harnessPid` on `bus`, if its harness is still the process
 * that wrote it. A stale or unreadable record is deleted; one for another bus,
 * or one whose harness start time can't be read now, is kept and ignored.
 */
export function freshRecord(dir: string, harnessPid: number, bus: string): NameRecord | null {
  const path = recordPath(dir, harnessPid);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const r = parse(text);
  const start = procStart(harnessPid);
  if (start === null) return null;
  if (!r || r.harness_pid !== harnessPid || start !== r.harness_start) {
    rm(path);
    return null;
  }
  return r.bus === bus ? { ...r, session_id: asSessionId(r.session_id) } : null;
}

/**
 * Delete every record whose harness is gone, or isn't the process that wrote
 * it. A harness whose start time can't be read keeps its record.
 */
export function sweepRecords(dir: string): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(PREFIX) && /^\d+$/.test(f.slice(PREFIX.length)));
  } catch {
    return;
  }
  const recs = files.map((f) => {
    try {
      return { f, r: parse(readFileSync(join(dir, f), "utf8")) };
    } catch {
      return { f, r: null };
    }
  });
  const starts = procStarts(recs.flatMap(({ r }) => (r ? [r.harness_pid] : [])));
  for (const { f, r } of recs) {
    const start = r ? starts.get(r.harness_pid) : undefined;
    if (!r || (start !== null && start !== r.harness_start)) rm(join(dir, f));
  }
}

/**
 * At exit: delete this session's record if it holds no name. A bound exit
 * keeps its record, so a grayboard restarted under the same harness (`/mcp`
 * reconnect) takes the names back; a record a successor already rewrote is left.
 */
export function dropUnboundRecord(dir: string, harnessPid: number, sessionId: string): void {
  const path = recordPath(dir, harnessPid);
  let r: NameRecord | null;
  try {
    r = parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  if (r && r.session_id === sessionId && r.names.length === 0) rm(path);
}

function rm(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
