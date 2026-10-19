#!/usr/bin/env bun
// Token-usage analysis for grayboard: how much of a machine's Claude Code token
// spend grayboard costs (fixed per-call context, bus text in context, pushes that
// woke an agent only to coordinate) versus the work it routes. Read-only.
//
//   bun scripts/usage.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//                        [--projects DIR] [--db PATH | --no-db]
//                        [--chars-per-token N] [--schema-chars N] [--raw-lanes] [--rows]
//
// Writes one JSON document to stdout; --rows flattens it to {rows: [...]}, one
// row per slice keyed by `id` ("<table>:<key>"), for charting tools. Inputs: Claude Code transcripts
// (~/.claude/projects/*/*.jsonl and their subagents/) and, optionally, the local
// bus database opened read-only. Counts are raw tokens as the API reports them;
// no prices. Project directory names are aliased (lane-1, lane-2, …) unless
// --raw-lanes, since they name private repos.
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    since: { type: "string" },
    until: { type: "string" },
    projects: { type: "string", default: join(homedir(), ".claude/projects") },
    db: { type: "string", default: process.env.BUS_DB_PATH ?? join(homedir(), ".claude-bus/bus.db") },
    "no-db": { type: "boolean", default: false },
    "chars-per-token": { type: "string", default: "3.7" },
    "schema-chars": { type: "string" },
    "raw-lanes": { type: "boolean", default: false },
    rows: { type: "boolean", default: false },
  },
});

const DAY = 86_400_000;
const until = args.until ? Date.parse(args.until) : Date.now();
const since = args.since ? Date.parse(args.since) : until - 7 * DAY;
if (Number.isNaN(since) || Number.isNaN(until)) throw new Error("--since/--until must be YYYY-MM-DD");
const CPT = Number(args["chars-per-token"]);

// ── token accounting ────────────────────────────────────────────────────────

type Tok = { input: number; cache_write: number; cache_read: number; output: number };
const zero = (): Tok => ({ input: 0, cache_write: 0, cache_read: 0, output: 0 });
const total = (t: Tok) => t.input + t.cache_write + t.cache_read + t.output;
const ctxOf = (t: Tok) => t.input + t.cache_write + t.cache_read;
function add(a: Tok, b: Tok): Tok {
  a.input += b.input; a.cache_write += b.cache_write; a.cache_read += b.cache_read; a.output += b.output;
  return a;
}
function usageTok(u: any): Tok {
  return {
    input: u.input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

type Bucket = { turns: number; calls: number; tokens: Tok };
const bucket = (): Bucket => ({ turns: 0, calls: 0, tokens: zero() });
function get<K, V>(m: Map<K, V>, k: K, mk: () => V): V {
  let v = m.get(k);
  if (v === undefined) m.set(k, (v = mk()));
  return v;
}

// ── turn origin ─────────────────────────────────────────────────────────────
// A turn starts at a user entry that isn't a tool result or meta reminder; its
// origin says what woke the model. Grayboard pushes carry origin.kind "channel"
// with server "grayboard"; the tag's attributes say DM, board post or digest.

function textOf(c: any): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  if (c.length && c.every((b) => b?.type === "tool_result")) return "";
  return c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ");
}

// Channel pushes are marked isMeta, so check them before skipping meta entries.
function originOf(d: any): string | null {
  if (d.isCompactSummary) return null;
  const s = textOf(d.message?.content).trim();
  const og = d.origin ?? {};
  if (og.kind === "channel" && s) {
    if (og.server !== "grayboard") return `channel:${og.server}`;
    if (s.includes('human="true"')) return "gb:human-relay";
    // A deferred push only rides along with the one that woke the session.
    if (/^<channel[^>]*\bdeferred="true"/.test(s)) return "gb:deferred";
    if (s.includes('kind="digest"')) return "gb:digest";
    if (/^<channel[^>]*\bboard="/.test(s)) return "gb:board";
    return "gb:dm";
  }
  if (d.isMeta || !s) return null;
  if (s.startsWith("<command-") || s.startsWith("<local-command")) return "slash-cmd";
  switch (og.kind) {
    case "task-notification": return "bg-task";
    case "plugin": return `plugin:${og.name}`;
    case "peer": case "coordinator": return "peer-session";
    case "human": return "human";
  }
  if (s.includes("<task-notification>")) return "bg-task";
  if (s.startsWith("<system-reminder>")) return null;
  return "human";
}

// ── accumulators ────────────────────────────────────────────────────────────

const totals = { calls: 0, tokens: zero() };
const byModel = new Map<string, Bucket>();
const byOrigin = new Map<string, Bucket>(); // "gb:board:coord", "human", …
// silent: the subset of coord turns that changed nothing on the bus (no post,
// DM, ack, claim or subscription): a wake that bought only reading.
type Sides = { coord: Bucket; work: Bucket; silent: Bucket };
const byBoard = new Map<string, Sides>();
const byReason = new Map<string, Sides>();
const GB_WRITES = new Set(["board_post", "dm_send", "dm_ack", "dm_retract", "claim_take", "claim_release", "claim_watch", "board_subscribe", "board_create", "peer_status"].map((t) => `mcp__grayboard__${t}`));
const byLane = new Map<string, { tokens: Tok; gb_push_tokens: Tok; gb_coord_tokens: Tok; sessions: number }>();
const wakes: { ctx: number; cold: boolean; origin: string }[] = [];
const tools = new Map<string, { calls: number; input_chars: number; result_chars: number; results: number }>();
const overhead = { context_tokens: 0, fixed_instructions_tokens: 0, fixed_schema_tokens: 0, gb_sessions: 0, calls_with_gb: 0 };
const instrDeltas: number[] = [];
const seenMsg = new Set<string>();
const seenTool = new Set<string>();
const gbToolIds = new Map<string, string>();
let files = 0, sessions = 0, compactions = 0, deferred = 0;

// Always-load tool schemas sit in every call's prompt but never in transcripts:
// measure them by asking a scratch local-mode server for its tool list.
async function schemaChars(): Promise<number> {
  if (args["schema-chars"]) return Number(args["schema-chars"]);
  const dir = mkdtempSync(join(tmpdir(), "gb-usage-"));
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli/main.ts"), "mcp", "--mode", "local"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, BUS_IDENTITY: "usage-probe", BUS_DB_PATH: `${dir}/bus.db`, BUS_SOCK_DIR: `${dir}/sock`, GRAYBOARD_CREDENTIALS: `${dir}/nocreds` },
  });
  const send = (o: unknown) => { p.stdin.write(JSON.stringify(o) + "\n"); p.stdin.flush(); };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "usage", version: "0" } } });
    const reader = p.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (m.id === 2) {
          const always = m.result.tools.filter((t: any) => t._meta?.["anthropic/alwaysLoad"]);
          return JSON.stringify(always).length;
        }
      }
    }
    throw new Error("timed out");
  } catch (e) {
    console.error(`usage: schema probe failed (${e}); pass --schema-chars`);
    return 0;
  } finally {
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function transcriptFiles(root: string): { path: string; lane: string; subagent: boolean }[] {
  const out: { path: string; lane: string; subagent: boolean }[] = [];
  const fresh = (p: string) => statSync(p).mtimeMs >= since;
  for (const lane of readdirSync(root)) {
    const ld = join(root, lane);
    if (!statSync(ld).isDirectory()) continue;
    for (const e of readdirSync(ld, { withFileTypes: true })) {
      const p = join(ld, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl") && fresh(p)) out.push({ path: p, lane, subagent: false });
      const sub = join(p, "subagents");
      if (e.isDirectory() && existsSync(sub))
        for (const s of readdirSync(sub))
          if (s.endsWith(".jsonl") && fresh(join(sub, s))) out.push({ path: join(sub, s), lane, subagent: true });
    }
  }
  return out;
}

function scan(path: string, lane: string, subagent: boolean, schemaTok: number) {
  const L = get(byLane, lane, () => ({ tokens: zero(), gb_push_tokens: zero(), gb_coord_tokens: zero(), sessions: 0 }));
  L.sessions++;
  sessions++;
  let gbLiveChars = 0; // grayboard text currently in this session's context
  let instrTok = 0; // grayboard MCP instructions, once the session has them
  let hasGb = false;
  let origin = subagent ? "subagent" : "session-start";
  let board = "", reason = "";
  let turn: { tok: Tok; calls: number; tools: Set<string> } | null = null;

  const closeTurn = () => {
    if (!turn || !turn.calls) return;
    let key = origin;
    if (origin.startsWith("gb:")) {
      // ToolSearch only loads deferred tool schemas, so it counts as coordination too.
      const coord = [...turn.tools].every((t) => t.startsWith("mcp__grayboard__") || t === "ToolSearch");
      key += coord ? ":coord" : ":work";
      add(L.gb_push_tokens, turn.tok);
      if (coord) add(L.gb_coord_tokens, turn.tok);
      const silent = coord && ![...turn.tools].some((t) => GB_WRITES.has(t));
      for (const [m, k] of [[byBoard, board], [byReason, reason]] as const) {
        if (!k) continue;
        const sides = get(m, k, () => ({ coord: bucket(), work: bucket(), silent: bucket() }));
        for (const b of [sides[coord ? "coord" : "work"], ...(silent ? [sides.silent] : [])]) {
          b.turns++; b.calls += turn.calls; add(b.tokens, turn.tok);
        }
      }
    }
    const b = get(byOrigin, key, bucket);
    b.turns++; b.calls += turn.calls; add(b.tokens, turn.tok);
  };

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "system" && d.subtype === "compact_boundary") { gbLiveChars = 0; compactions++; continue; }
    const a = d.attachment;
    if (d.type === "attachment" && a?.type === "mcp_instructions_delta" && (a.addedNames ?? []).includes("grayboard")) {
      const blk: string = (a.addedBlocks ?? []).find((b: string) => b.startsWith("## grayboard")) ?? "";
      instrTok = blk.length / CPT;
      instrDeltas.push(blk.length);
      if (!hasGb) { hasGb = true; overhead.gb_sessions++; }
      continue;
    }
    const m = d.message ?? {};
    const c = m.content;
    if (d.type === "user") {
      let o = subagent ? null : originOf(d);
      if (o === "gb:deferred") { deferred++; o = null; }
      if (o) {
        closeTurn();
        origin = o; turn = { tok: zero(), calls: 0, tools: new Set() };
        const head = textOf(c).slice(0, 400);
        board = /board="([^"]+)"/.exec(head)?.[1] ?? "";
        reason = o.startsWith("gb:") ? (/reason="([^"]+)"/.exec(head)?.[1] ?? o.slice(3)) : "";
      }
      for (const x of textOf(c).match(/<channel source="grayboard"[^>]*>[\s\S]*?<\/channel>/g) ?? []) gbLiveChars += x.length;
      if (Array.isArray(c))
        for (const b of c) {
          if (b?.type !== "tool_result" || !gbToolIds.has(b.tool_use_id)) continue;
          const n = JSON.stringify(b.content ?? "").length;
          gbLiveChars += n;
          if (!seenTool.has("r" + b.tool_use_id)) {
            seenTool.add("r" + b.tool_use_id);
            const t = tools.get(gbToolIds.get(b.tool_use_id)!)!;
            t.result_chars += n; t.results++;
          }
        }
      continue;
    }
    if (d.type !== "assistant") continue;
    if (Array.isArray(c))
      for (const b of c) {
        if (b?.type !== "tool_use") continue;
        turn?.tools.add(b.name ?? "");
        if (!String(b.name).startsWith("mcp__grayboard__")) continue;
        const n = JSON.stringify(b.input ?? {}).length;
        gbLiveChars += n;
        gbToolIds.set(b.id, b.name.slice(16));
        if (!seenTool.has(b.id)) {
          seenTool.add(b.id);
          const t = get(tools, b.name.slice(16), () => ({ calls: 0, input_chars: 0, result_chars: 0, results: 0 }));
          t.calls++; t.input_chars += n;
        }
      }
    const ts = Date.parse(d.timestamp ?? "");
    if (!m.usage || !m.id || seenMsg.has(m.id) || !(ts >= since && ts < until) || m.model === "<synthetic>") continue;
    seenMsg.add(m.id);
    const tok = usageTok(m.usage);
    const ctx = ctxOf(tok);
    totals.calls++; add(totals.tokens, tok);
    const mb = get(byModel, m.model ?? "unknown", bucket);
    mb.calls++; add(mb.tokens, tok);
    add(L.tokens, tok);
    if (turn) {
      if (turn.calls === 0 && origin.startsWith("gb:"))
        wakes.push({ ctx, cold: tok.cache_write > ctx / 2, origin });
      turn.calls++; add(turn.tok, tok);
    } else {
      const b = get(byOrigin, origin, bucket);
      b.calls++; add(b.tokens, tok);
    }
    overhead.context_tokens += Math.min(gbLiveChars / CPT, ctx);
    if (hasGb) {
      overhead.calls_with_gb++;
      overhead.fixed_instructions_tokens += Math.min(instrTok, ctx);
      overhead.fixed_schema_tokens += Math.min(schemaTok, ctx);
    }
  }
  closeTurn();
}

// ── bus database (optional) ─────────────────────────────────────────────────

function busStats(path: string) {
  const db = new Database(path, { readonly: true });
  const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const w = [since, until];
  const dms = db.query(`SELECT sender, recipient, COUNT(*) n, SUM(LENGTH(body)) chars FROM messages
    WHERE created_at >= ? AND created_at < ? GROUP BY sender, recipient ORDER BY n DESC`).all(...w);
  // Root DMs nobody answered (no later message in the thread) or acked.
  const unanswered = db.query(`SELECT COUNT(*) n FROM messages m
    WHERE m.parent_id IS NULL AND m.created_at >= ? AND m.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM dm_acks a WHERE a.message_id = m.id)`).get(...w) as { n: number };
  const posts = db.query(`SELECT board, COUNT(*) n, SUM(LENGTH(body)) chars FROM posts
    WHERE created_at >= ? AND created_at < ? GROUP BY board ORDER BY n DESC`).all(...w);
  const subs = db.query(`SELECT board, mode, COUNT(*) n FROM subscriptions GROUP BY board, mode ORDER BY board`).all();
  const claimEvents = has("claim_events")
    ? db.query(`SELECT event, COUNT(*) n FROM claim_events WHERE at >= ? AND at < ? GROUP BY event`).all(...w)
    : null;
  const refusals = has("claim_events")
    ? db.query(`SELECT substr(key, 1, instr(key || ':', ':') - 1) prefix, COUNT(*) n FROM claim_events
        WHERE event = 'refused' AND at >= ? AND at < ? GROUP BY prefix`).all(...w)
    : null;
  db.close();
  return { dms, unanswered_root_dms: unanswered.n, posts, subscriptions: subs, claim_events: claimEvents, claim_refusals_by_prefix: refusals };
}

// ── run ─────────────────────────────────────────────────────────────────────

const schemaLen = await schemaChars();
const list = transcriptFiles(args.projects!);
for (const f of list) { files++; scan(f.path, f.lane, f.subagent, schemaLen / CPT); }

const all = total(totals.tokens);
const pct = (n: number) => +(100 * n / all).toFixed(2);
const withPct = (b: Bucket) => ({ ...b, total: total(b.tokens), pct: pct(total(b.tokens)) });
const pctile = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0;

const laneNames = [...byLane.entries()].sort((a, b) => total(b[1].tokens) - total(a[1].tokens));
const aliasLane = new Map(laneNames.map(([k], i) => [k, args["raw-lanes"] ? k : `lane-${i + 1}`]));

const coordTok = [...byOrigin.entries()].filter(([k]) => k.endsWith(":coord")).reduce((s, [, b]) => s + total(b.tokens), 0);
const workTok = [...byOrigin.entries()].filter(([k]) => k.endsWith(":work")).reduce((s, [, b]) => s + total(b.tokens), 0);
const fixedTok = overhead.fixed_instructions_tokens + overhead.fixed_schema_tokens;
const wakeCtx = wakes.map((w) => w.ctx).sort((a, b) => a - b);

const out = {
  meta: {
    generated_at: new Date().toISOString(),
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    files, sessions, compactions,
    chars_per_token: CPT,
    schema_chars: schemaLen,
    instructions_chars_median: pctile(instrDeltas.sort((a, b) => a - b), 0.5),
    notes: [
      "tokens are API-reported per call, deduplicated by message id (transcripts repeat on resume)",
      "total = input + cache_write + cache_read + output",
      "gb:*:coord = push-started turns whose only tool calls were grayboard tools or ToolSearch (or none)",
      "push_by_*.silent = the coord turns with no grayboard write (post, DM, ack, claim, subscription)",
      "deferred pushes ride along with the push that woke the session, so they start no turn of their own",
      "context/fixed overhead are estimates from character counts / chars_per_token, capped at each call's context size",
      "overhead components overlap: coord turns already include their context and fixed tokens",
    ],
  },
  totals: { calls: totals.calls, tokens: totals.tokens, total: all },
  by_model: Object.fromEntries([...byModel].map(([k, b]) => [k, withPct(b)])),
  by_origin: Object.fromEntries([...byOrigin].sort((a, b) => total(b[1].tokens) - total(a[1].tokens)).map(([k, b]) => [k, withPct(b)])),
  overhead: {
    coord_turn_tokens: coordTok, coord_turn_pct: pct(coordTok),
    context_tokens: Math.round(overhead.context_tokens), context_pct: pct(overhead.context_tokens),
    fixed_instructions_tokens: Math.round(overhead.fixed_instructions_tokens), fixed_schema_tokens: Math.round(overhead.fixed_schema_tokens),
    fixed_pct: pct(fixedTok),
    upper_bound_pct: pct(coordTok + overhead.context_tokens + fixedTok),
    gb_sessions: overhead.gb_sessions, calls_with_gb: overhead.calls_with_gb,
    routed_work_tokens: workTok, routed_work_pct: pct(workTok),
  },
  wakes: {
    count: wakes.length, cold: wakes.filter((w) => w.cold).length, deferred_pushes: deferred,
    context_tokens: { p50: pctile(wakeCtx, 0.5), p90: pctile(wakeCtx, 0.9), max: wakeCtx.at(-1) ?? 0 },
  },
  push_by_board: Object.fromEntries([...byBoard].map(([k, v]) => [k, { coord: withPct(v.coord), work: withPct(v.work), silent: withPct(v.silent) }])),
  push_by_reason: Object.fromEntries([...byReason].map(([k, v]) => [k, { coord: withPct(v.coord), work: withPct(v.work), silent: withPct(v.silent) }])),
  by_lane: laneNames.map(([k, v]) => ({
    lane: aliasLane.get(k), sessions: v.sessions, total: total(v.tokens), pct: pct(total(v.tokens)),
    gb_push_total: total(v.gb_push_tokens), gb_coord_total: total(v.gb_coord_tokens),
  })),
  tools: Object.fromEntries([...tools].sort((a, b) => b[1].calls - a[1].calls).map(([k, t]) => [k, {
    calls: t.calls, input_chars_avg: Math.round(t.input_chars / t.calls),
    result_chars_avg: t.results ? Math.round(t.result_chars / t.results) : null,
  }])),
  bus: !args["no-db"] && existsSync(args.db!) ? busStats(args.db!) : null,
};

// One flat table: every row has `table` and `key`; columns vary by table.
function toRows() {
  const rows: Record<string, unknown>[] = [];
  const row = (table: string, key: string, cols: Record<string, unknown>) => rows.push({ id: `${table}:${key}`, table, key, ...cols });
  const bk = (b: ReturnType<typeof withPct>) => ({ turns: b.turns, calls: b.calls, ...b.tokens, total: b.total, pct: b.pct });
  row("summary", "all", {
    since: out.meta.window.since, until: out.meta.window.until, generated_at: out.meta.generated_at,
    files, sessions: sessions - list.filter((f) => f.subagent).length, subagent_files: list.filter((f) => f.subagent).length,
    calls: totals.calls, ...totals.tokens, total: all,
    wakes: out.wakes.count, wakes_cold: out.wakes.cold, deferred_pushes: deferred, wake_ctx_p50: out.wakes.context_tokens.p50, wake_ctx_p90: out.wakes.context_tokens.p90,
    unanswered_root_dms: out.bus?.unanswered_root_dms ?? null,
  });
  for (const [k, b] of Object.entries(out.by_origin)) row("origin", k, bk(b));
  for (const [k, b] of Object.entries(out.by_model)) row("model", k, bk(b));
  const o = out.overhead;
  row("overhead", "coord_turns", { total: o.coord_turn_tokens, pct: o.coord_turn_pct });
  row("overhead", "context", { total: o.context_tokens, pct: o.context_pct });
  row("overhead", "fixed_instructions", { total: o.fixed_instructions_tokens, pct: pct(o.fixed_instructions_tokens) });
  row("overhead", "fixed_schemas", { total: o.fixed_schema_tokens, pct: pct(o.fixed_schema_tokens) });
  row("overhead", "upper_bound", { total: Math.round(o.coord_turn_tokens + o.context_tokens + o.fixed_instructions_tokens + o.fixed_schema_tokens), pct: o.upper_bound_pct });
  row("overhead", "routed_work", { total: o.routed_work_tokens, pct: o.routed_work_pct });
  for (const [table, src] of [["push_reason", out.push_by_reason], ["push_board", out.push_by_board]] as const)
    for (const [k, v] of Object.entries(src))
      row(table, k, {
        coord_turns: v.coord.turns, coord_total: v.coord.total, coord_pct: v.coord.pct,
        work_turns: v.work.turns, work_total: v.work.total, work_pct: v.work.pct,
        silent_turns: v.silent.turns, silent_total: v.silent.total, silent_pct: v.silent.pct,
      });
  for (const l of out.by_lane) row("lane", l.lane!, l);
  for (const [k, t] of Object.entries(out.tools)) row("tool", k, t);
  return { rows };
}
console.log(JSON.stringify(args.rows ? toRows() : out, null, 2));
