# Postgres server

```doc-meta
owns: the design of the server's move from synchronous SQLite to async Postgres (#807 Stage 3): the storage seam, transaction and concurrency model, schema and migrations, cutover, tests
invariants: local mode keeps its synchronous SQLite core unchanged; the server ends Postgres-only (no SQLite fallback once cut over, principle 12); a database invariant is enforced in SQL, never by "no other writer can run" (that held only for SQLite's single writer with a blocking transaction); inside a transaction every statement runs on that transaction's handle, never the pool; a transaction body awaits nothing but its own statements; until Stage 4, in-memory state a transaction reads is guarded by the one in-process write queue
code-pointers: src/server/db.ts (Repo, openDatabase, makeRepo, makeHostedStore), src/core/sqlite.ts (openSqlite, afterCommit), src/core/boards.ts (setAccess WeakMap), src/server/hosted.ts (run, withGate), src/server/application.ts (bindNow, writeSend), src/server/alias_cap.ts, src/server/write_dedup.ts, src/server/app.ts (openDatabase caller), tests/support/server.ts, scripts/loadtest.ts
companions: ../architecture.md (the server's data and the Postgres seam), ../vision.md (principles 8, 9, 12), ../server-hosted-mcp.md (hosted tool calls), ../server-access.md (authorization seam)
trigger: Stage 3 (#807) started; the decisions below are the maintainer's of 2026-11-14 plus this doc's
last-verified: 2026-11-15
```

## Problem

The server runs on one SQLite file. The target platform runs on Kubernetes against managed Postgres (RDS), and a SQLite pod there needs a persistent volume plus replication work that RDS makes throwaway, so Postgres moves ahead of the pilot (#807).

Facts that set the port's shape, from an inventory of `origin/master` (be48f91):

- **`Repo` is not the whole seam.** `src/server/db.ts` runs about 200 statements, but the raw `Database` also flows from `app.ts` into application, http, slack, teams, retention and the attachment modules, and they call the shared core (`src/core/`: boards, claims, bindings, session_end, delegation, attachments: about 160 statements) on it directly.
- **The core calls back into the server synchronously.** `src/core/boards.ts` keeps a `WeakMap<Database, Access>`; core statements call the server's `Access`, which reads through `Repo`. An async server core forces an async `Access`.
- **Correctness leans on a blocking transaction.** `repo.atomic` is `BEGIN IMMEDIATE` with a synchronous callback (`Sync<T>` makes a promise a type error). A hosted tool call is one such transaction (`hosted.ts` run). While it runs, nothing else in the process runs, so a transaction may read in-memory state (registry liveness, busy and inflight maps, delivery leases, BindGate, limiters) and nothing can change it before commit. About a dozen sites (`no await since` comments among them) depend on this.
- **Read-then-write invariants rely on the single writer.** At least: alias takeover in `holdAlias` and the `bindNow` checks, the alias cap (`alias_cap.ts` says so), `teams.create`, `guardLastOwner`, OAuth `redeemCode` and `rotateRefresh` replay detection, the `createRequest` capacity count, the attachment quota, `dedupWrite`, `claims.take`, and the hosted `full()` capacity check. Postgres's default READ COMMITTED serializes none of them.
- **`afterCommit` and the auth cache are SQLite mechanisms.** `afterCommit` monkey-patches `db.transaction`; the auth cache is keyed on TEMP triggers plus `PRAGMA data_version`.
- **The driver.** `Bun.SQL` (built in; no dependency) speaks Postgres. Probed on Bun 1.4.4 against `postgres:18`: `int8` returns as a string (or `BigInt` with `bigint: true`; no per-type parser, and `BigInt` breaks `JSON.stringify`); SQLSTATE is in the error's `errno` (`40001`, `23505`), not `code`; `sql.begin(...)` gives a transaction handle; `RETURNING` and `ON CONFLICT ... DO NOTHING` behave as in Postgres.

## Decisions

### D1. Fork the server core; local keeps its own (maintainer, 2026-11-14)

The server gets its own async core on Postgres under `src/server/store/`. `src/core/` stays synchronous SQLite for local mode and loses its server callers. Drift between the two is caught by a black-box conformance suite on the tool surface run against both modes, not by sharing code. The server's copies of board, claim, binding, session-end, delegation and attachment logic are ports, so a later fix to one side names the other in its PR (the conformance suite is the backstop).

### D2. Transactions are explicit values

- `type Read` is a statement handle (the pool, or a transaction); `type Tx extends Read` adds `afterCommit(fn)` and `savepoint(fn)`. Every store function that writes takes a `Tx`; one that only reads takes a `Read`. No module holds an ambient pool it can query behind a caller's transaction: a stray pool query inside a transaction runs outside it, and at pool exhaustion it deadlocks against the transaction holding the last connection.
- `atomic(fn)` opens a transaction and passes the `Tx`. A nested `atomic` inside one is a type error; nesting goes through `tx.savepoint`.
- `afterCommit` callbacks live on the `Tx` and run in registration order after `COMMIT` resolves, never on rollback. This replaces the `db.transaction` monkey-patch.
- `Access` (the authorization seam) becomes async and takes the caller's `Read`, so a policy read inside a transaction sees that transaction.

### D3. Database invariants move into SQL

Each read-then-write invariant becomes one statement or a lock on a row the invariant hangs off, so it holds at any isolation level and on any number of pods:

| Invariant | Form |
|---|---|
| OAuth code single use; refresh-token rotation replay | `UPDATE ... SET spent_at = $now WHERE ... AND spent_at IS NULL RETURNING ...`: zero rows means replay, and the replay path revokes the grant |
| Alias takeover (`holdAlias`), claim take | `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE <the takeover is allowed> RETURNING ...`: zero rows means held |
| Write dedup (`dedupWrite`) | insert the receipt first (`ON CONFLICT DO NOTHING RETURNING`); zero rows means a duplicate, which reads the stored result |
| Principal names unique across users, teams and aliases (`teams.create`) | a unique index on the shared name; `23505` maps to `PrincipalTaken` |
| Count caps: alias cap per scope, OAuth request capacity, attachment quota per user, hosted `full()` | `SELECT ... FOR UPDATE` on the parent row (the scope, the user, the server's capacity row), then count and insert |
| A team keeps an owner (`guardLastOwner`) | `FOR UPDATE` on the team row, then count owners |

These forms also run on SQLite except `FOR UPDATE`, which SQLite's single writer makes unnecessary, so D3 lands before Postgres does (P2 below) and is tested against today's suite.

Isolation stays READ COMMITTED. SERIALIZABLE everywhere would turn every conflict into a retry of a whole tool call, whose in-memory side effects then need making re-runnable, for no gain at one pod.

### D4. In-memory state: one write queue until Stage 4

Stage 3 is one server pod. Once statements are awaited, other requests run between them, so a transaction that reads the registry, a lease map, BindGate or a limiter can see it change before commit. SERIALIZABLE does not cover memory, and an advisory lock helps only if every in-memory mutator takes it.

- Every write transaction runs through one in-process async queue (a mutex). In-memory state a transaction reads is mutated only inside a queued transaction or its `afterCommit`. That restores today's guarantee, "nothing else writes while I'm in a transaction", without depending on the event loop being blocked.
- A transaction body awaits only its own statements: no network, no blob I/O, no timers, no hooks. A blob `put` already happens outside the row's transaction (`core/attachments.ts`) and stays that way. A test enforces this (a queued body that awaits anything other than its `Tx` fails).
- Reads run concurrently on the pool, outside the queue.
- Granularity is measured, not guessed: the vertical slice (P4) runs `scripts/loadtest.ts` against Postgres. Narrow to queues keyed by session or scope only if the 1,000-session p99 < 100 ms bar fails. One global queue also rules out deadlocks among the server's own transactions.
- Stage 4 (#808) externalizes this state (leases, issued sets, wake fan-out); the queue is the thing it replaces, which is why D3 does not lean on it.

### D5. Hot reads stay in process

`authRead` runs per tool call and once a second per open stream: at the Stage 1 load about 1,000 checks a second, which as round trips would dominate. Its generation becomes an in-process counter bumped in `afterCommit` by every write to `oauth_tokens`, `oauth_grants` and `users`. That is sound only while the server process is the database's only writer: today `openDatabase` has one caller (`src/server/app.ts`), and the other openers of a server database (`scripts/inspect.ts`, `scripts/usage.ts`) are read-only. Stage 4 replaces the counter with `LISTEN/NOTIFY` or a generation row.

### D6. Types and SQL

- Timestamps stay integer milliseconds in `int8` (`bigint`); ids are `int8 GENERATED ALWAYS AS IDENTITY`. Row mappers in the store convert `int8` strings to `number` (every value is below 2^53); nothing above the store sees a string id or time.
- Booleans become `boolean`. JSON columns become `jsonb`; `json_each`/`json_extract` become `jsonb_array_elements`/`->>`.
- SQLite forms map: `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; `INSERT OR REPLACE` → `ON CONFLICT ... DO UPDATE`; two-argument scalar `MAX` → `GREATEST`; `IS NOT ?` → `IS DISTINCT FROM`; `rowid`, `last_insert_rowid`, `.changes` → `RETURNING` and the result count; `?N` → `$N` (tagged templates). `+col` planner hints and the `EXPLAIN QUERY PLAN` pins in `db.test.ts` don't carry over; plan pins that matter are rewritten against `EXPLAIN (FORMAT JSON)`.
- Errors are classified by `errno` (SQLSTATE) in one place: `23505` with its `constraint` to the domain refusal it means; `40001`/`40P01` cannot arise at READ COMMITTED without explicit locks out of order, and are treated as server errors if they do.

### D7. Schema and migrations

- The Postgres schema is new DDL, not a translation of `CREATE TABLE IF NOT EXISTS` plus guarded `ALTER`s. Legacy tables (`identities`, `cursors`, `handles`) and `hosted_sessions.name` are not carried over.
- Migrations are numbered SQL files in `src/server/migrations/`, applied at boot in order under `pg_advisory_lock`, recorded in `schema_migrations`. Changes follow expand/contract: a release adds (columns, tables, dual writes), a later release removes once no running version reads the old shape. This replaces "schema changes are additive" for the server; local mode keeps that rule.
- Open-time data steps that are migrations in all but name (`migrateHostedHolds`, `seedSchema`, the attachment backfill) are not ported: the import (D8) starts from a database HEAD already opened.

### D8. Landing and cutover

Master stays releasable throughout; the released server stays SQLite until the cutover release.

1. **P1, the async seam on SQLite.** `src/server/store/` with D2's types over the existing SQLite code, the write queue (D4), explicit `afterCommit`, async `Access`. Reads use a second SQLite connection, because a read on the writer's connection during a queued transaction would see its uncommitted rows. Behaviour-preserving: today's suite passes unchanged in meaning. This is where in-memory races first become possible, so it lands with D4's queue, not after it.
2. **P2, invariants into SQL (D3)** on SQLite, each with a test that interleaves two callers at a `testPause` point and fails on the old code.
3. **P3, the Postgres store** behind the same interface: DDL, migrations, row mappers, the core's server-side ports. The server picks Postgres when `GRAYBOARD_DATABASE_URL` is set; unreleased until P5.
4. **P4, the vertical slice measured**: hosted tool call → `board_post`, bind, claim take on Postgres under `scripts/loadtest.ts`; tune queue granularity (D4) if the bar fails.
5. **P5, cutover.** `grayboard-server import-sqlite <path>` copies a live server database into an empty Postgres (one-time, offline, server stopped). The release that ships it deletes the SQLite server store; `GRAYBOARD_DB_PATH` on the server becomes a startup error naming the import. The v1.0.0 upgrade floor retires for the server here (maintainer, 2026-11-14), replaced by "the current release's server database imports" and, for local mode, "the current release's database opens under HEAD".

The two stores coexist only between P3 and P5, inside the repo, never in a release: not a shim (principle 12).

### D9. Tests

- **Isolation by template database.** A suite-level setup creates `gb_template` once (migrations applied); each test's server gets `CREATE DATABASE ... TEMPLATE gb_template`, dropped after. `TestServer` and `ServerProcess` take the URL; `GRAYBOARD_TEST_PG_URL` names the cluster. Until CI has a Postgres service container (a `.github/workflows/` change, the maintainer's batched push), Postgres-backed tests skip when the variable is unset, and the SQLite store keeps the suite's coverage.
- **Helpers go through the store.** `hostedRowCount`, `accessAudits`, `busRows`-style readers become async store reads, so tests stop issuing SQL. The 82 test files that run SQL directly are ported with the module they test, not up front.
- **Conformance suite (D1)**: tool-surface scenarios (DM, board, claim, bind, delegate) run against local mode and the hosted server; it starts small in P3 and grows with each port.
- **Concurrency tests** force interleavings at `testPause` points (P2), never sleeps.

## Open questions

- **Postgres major.** The RDS major the platform runs; CI and local tests pin the same image. `postgres:18` until the platform answers.
- **Pool size.** `Bun.SQL` defaults to 10. With D4's single write queue one connection writes at a time, so the pool serves reads. Size it from P4's measurements, against the RDS instance's `max_connections`.
- **Inspector and usage scripts.** `scripts/inspect.ts` (a released binary) and `scripts/usage.ts` read a server's SQLite file. At P5 they either read Postgres or drop their server views; decide before the cutover release.
- **Import window.** P5's import is offline: the team server is down for the copy. The live database is small, but measure it before choosing offline over dual-write.

## Not in scope

HA, multiple pods, blobs in object storage, and externalized hub state are Stage 4 (#808). This design keeps them possible: D3's invariants hold across pods, and D4/D5 name exactly what Stage 4 replaces.
