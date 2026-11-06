// `grayboard retention`: show or store how long this machine's local bus keeps
// history. Local whatever this machine is signed in to, like `grayboard mcp`.
import { DEFAULT_RETENTION_DAYS, parseRetentionDays } from "../core/boards.ts";
import { localDbPath } from "../local/open.ts";
import { readRetentionSetting, writeRetentionSetting, type RetentionSetting } from "../local/retention.ts";

const SETTINGS = "off, a whole number of days, or default";

const describe = (s: RetentionSetting) => (s.days === null ? "off" : `${s.days} days`);

export function runRetention(value: string | undefined, opts: { json?: boolean }, env: Record<string, string | undefined> = process.env): number {
  try {
    const path = localDbPath(env);
    if (value !== undefined) return store(value, path);
    return show(path, opts, env);
  } catch (e) {
    console.error(`[grayboard] retention: ${(e as Error).message}`);
    return 1;
  }
}

function store(value: string, path: string): number {
  let days: number | null | undefined;
  if (value === "off") days = null;
  else if (value !== "default") {
    const parsed = parseRetentionDays(value, DEFAULT_RETENTION_DAYS);
    if (value === "" || parsed === null || !Number.isSafeInteger(parsed)) {
      console.error(`[grayboard] retention: "${value}" isn't ${SETTINGS}`);
      return 1;
    }
    days = parsed;
  }
  const before = writeRetentionSetting(path, days);
  const was = before ? `; was ${describe(before)}` : "";
  if (days === undefined) console.log(`retention: no stored setting in ${path}; BUS_RETENTION_DAYS or the ${DEFAULT_RETENTION_DAYS}-day default applies${was}`);
  else console.log(`retention: ${days === null ? "off" : `${days} days`}, stored in ${path}${was}`);
  return 0;
}

function show(path: string, opts: { json?: boolean }, env: Record<string, string | undefined>): number {
  const stored = readRetentionSetting(path);
  const raw = env.BUS_RETENTION_DAYS;
  const fromEnv = parseRetentionDays(raw, DEFAULT_RETENTION_DAYS);
  // Null here is a malformed value, never off: a session with this env won't start.
  if (!stored && fromEnv === null) {
    console.error(`[grayboard] retention: BUS_RETENTION_DAYS must be a whole number of days, not "${raw}"`);
    return 1;
  }
  // A stored setting decides; otherwise a session started with this env decides.
  const days = stored ? stored.days : fromEnv;
  const source = stored ? "stored" : raw ? "env" : "default";
  if (opts.json) {
    console.log(JSON.stringify({ retention: days === null ? "off" : days, source, path, set_at: stored?.set_at ?? null, ...(raw ? { env: raw } : {}) }));
    return 0;
  }
  if (stored) console.log(`retention: ${describe(stored)}, stored in ${path}, set ${new Date(stored.set_at).toISOString()}${raw ? ` (outranks BUS_RETENTION_DAYS=${raw})` : ""}`);
  else console.log(`retention: ${days} days, from ${source === "env" ? "BUS_RETENTION_DAYS in this shell" : "the default"}; nothing stored in ${path}`);
  return 0;
}
