// Raw SQL on a server's own database, whichever backend it's on (#807 P3 C11c): a test's look at rows no store read
// answers, or a fixture write no store method makes. Prefer the Repo's own reads (docs/future/postgres-server.md D9);
// this is for the rest. SQL is written with `?` placeholders and converted to `$n` here for Postgres, so values are
// always bound, never spliced into the text. Write the SQL both dialects take: `id` not `rowid`, TRUE/FALSE for a
// boolean column (SQLite takes the keywords), no pragma or `INSERT OR IGNORE`, and `LIKE` patterns in the stored case
// (Postgres's LIKE is case sensitive).
//
// Rows come back as SQLite's would: an int8 column as a number, a boolean as 1 or 0, a json/jsonb column as its text.
// So a row compares equal on both backends. On Postgres, `exec` binding JSON text into a jsonb column stores a JSON
// string value, not an object (the stores parse first: src/server/store/pg/audit.ts); seed such a row through the
// store (writeAudit) when the test needs an object there.
//
// pgText numbers every `?` outside '…' and "…": it doesn't handle a `?` in a `--` comment, a `$$` block or an E'' string,
// nor the jsonb operators ?, ?| and ?&. Don't write those here.
import type { Repo } from "../../src/server/db.ts";
import { pgOf } from "../../src/server/store/pg/tx.ts";
import { isTx, sqliteOf, type Read, type Tx } from "../../src/server/store/tx.ts";
import { int8OrNull } from "../../src/server/store/pg/sql.ts";

export type Row = Record<string, unknown>;
// A Repo, or what holds one (a TestServer: `srv`, or its `app`).
export type RepoLike = Repo | { repo: Repo } | { app: { repo: Repo } };

export function repoOf(on: RepoLike): Repo {
  if ("app" in on) return on.app.repo;
  if ("repo" in on) return on.repo;
  return on;
}

type Handle = { kind: "sqlite"; run(sql: string, params: unknown[]): Row[] } | { kind: "pg"; run(sql: string, params: unknown[]): Promise<Row[]> };

// The statements of a store handle (the Repo's read, or a body's Tx), on the backend it belongs to.
function handle(r: Read): Handle {
  let db: ReturnType<typeof sqliteOf>;
  try {
    db = sqliteOf(r);
  } catch (error) {
    if (!(error instanceof Error && error.message === "not a SQLite store handle")) throw error;
    const sql = pgOf(r);
    return { kind: "pg", run: async (text, params) => normalize(await sql.unsafe(pgText(text), params)) };
  }
  return { kind: "sqlite", run: (text, params) => db.query(text).all(...(params as never[])) as Row[] };
}

// `?` → `$1, $2, …`, outside quoted strings and identifiers.
export function pgText(text: string): string {
  let out = "", n = 0, quote: string | null = null;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === "?" ? `$${++n}` : ch;
  }
  if (quote) throw new Error(`pgText: unterminated ${quote} in ${text}`);
  return out;
}

// Postgres type OIDs Bun returns other than as SQLite does.
const INT8 = 20, BOOL = 16, JSON_ = 114, JSONB = 3802;

function normalize(result: unknown): Row[] {
  const rows = result as Row[] & { columns?: { name: string; type: number }[] };
  const cols = rows.columns ?? [];
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const c of cols) {
      const v = out[c.name];
      if (v === null || v === undefined) continue;
      if (c.type === INT8) out[c.name] = int8OrNull(v);
      else if (c.type === BOOL) out[c.name] = v ? 1 : 0;
      else if (c.type === JSON_ || c.type === JSONB) out[c.name] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return out;
  });
}

// Every row `sql` returns, read on the Repo's read handle (committed state), or on a body's Tx.
export async function rows<T = Row>(on: RepoLike | Tx, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await handle(isRepoLike(on) ? repoOf(on).read : on).run(sql, params)) as T[];
}

// The first row, or null when there's none (as SQLite's `.get()`).
export async function row<T = Row>(on: RepoLike | Tx, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await rows<T>(on, sql, ...params))[0] ?? null;
}

// A write on a body's Tx (inside a test's `seed(repo, async tx => …)`).
export async function execOn(tx: Tx, sql: string, ...params: unknown[]): Promise<void> {
  await handle(tx).run(sql, params);
}

// A fixture's write as its own transaction through the server's write queue (seed.ts): what
// `seed(repo, () => db.run(sql, params))` was.
export function exec(on: RepoLike, sql: string, ...params: unknown[]): Promise<void> {
  return repoOf(on).write(async (tx: Tx) => { await execOn(tx, sql, ...params); });
}

// Resolves once every write queued before it has committed: a no-op body through the server's FIFO write queue. A
// post (an audit row, a deny row flushed after a rollback) runs at once on SQLite's idle queue but is always queued on
// Postgres, so a test reading what a request wrote waits here first. Don't call it while the test holds the queue.
export function drained(on: RepoLike): Promise<void> {
  return repoOf(on).write(() => undefined);
}

function isRepoLike(on: RepoLike | Tx): on is RepoLike {
  return !isTx(on as Read);
}

// Whether a write transaction is open, on either backend (#807 P3 C11c): what a spy read from SQLite's
// `db.inTransaction`. It counts the bodies passed to the Repo's write, post and hosted.write while each runs, which
// is every top-level transaction the server opens (each goes through one of them). `restore()` puts them back.
export function txSpy(on: RepoLike): { readonly open: boolean; restore(): void } {
  const repo = repoOf(on);
  let depth = 0;
  const counted = <F extends (tx: Tx) => unknown>(fn: F) => ((tx: Tx) => {
    depth++;
    let out: unknown;
    try {
      out = fn(tx);
    } catch (error) {
      depth--;
      throw error;
    }
    if (out !== null && typeof out === "object" && typeof (out as PromiseLike<unknown>).then === "function") {
      return Promise.resolve(out).finally(() => { depth--; });
    }
    depth--;
    return out;
  }) as F;
  const write = repo.write, post = repo.post, hostedWrite = repo.hosted.write;
  const wrapped = repo as unknown as Record<"write" | "post", unknown>;
  wrapped.write = (fn: (tx: Tx) => unknown, ...rest: unknown[]) => (write as (...a: unknown[]) => unknown).call(repo, counted(fn), ...rest);
  wrapped.post = (fn: (tx: Tx) => unknown, ...rest: unknown[]) => (post as (...a: unknown[]) => unknown).call(repo, counted(fn), ...rest);
  (repo.hosted as unknown as Record<"write", unknown>).write = (fn: (tx: Tx) => unknown, ...rest: unknown[]) =>
    (hostedWrite as (...a: unknown[]) => unknown).call(repo.hosted, counted(fn), ...rest);
  return {
    get open() { return depth > 0; },
    restore() {
      wrapped.write = write;
      wrapped.post = post;
      (repo.hosted as unknown as Record<"write", unknown>).write = hostedWrite;
    },
  };
}
