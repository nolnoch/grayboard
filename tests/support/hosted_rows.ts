import { type RepoLike, row } from "./repo_sql.ts";

type SqliteDb = { query(sql: string): { get(): unknown } };
const COUNT = "SELECT count(*) AS n FROM hosted_sessions";

// Every hosted_sessions row, parked children included (#584): `repo.hosted.all(repo.read)` leaves parked children out, so a
// deletion assert on it would also pass with a parked row left behind. Given the server (or its Repo), on either
// backend (#807 P3 C11c); given a SQLite connection, read there synchronously (callers not yet ported).
export function hostedRowCount(on: SqliteDb): number;
export function hostedRowCount(on: RepoLike): Promise<number>;
export function hostedRowCount(on: SqliteDb | RepoLike): number | Promise<number> {
  if (isSqliteDb(on)) return (on.query(COUNT).get() as { n: number }).n;
  return row<{ n: number }>(on, COUNT).then(r => r!.n);
}

export function isSqliteDb(on: object): on is { query: unknown } {
  return "query" in on && typeof (on as { query: unknown }).query === "function" && !("read" in on);
}
