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

- **`Repo` is not the whole seam.** `src/server/db.ts` runs most of the server's statements, but the raw `Database` also flows from `app.ts` into application, http, slack, teams, retention and the attachment modules, and they call the shared core (`src/core/`: boards, claims, bindings, session_end, delegation, attachments) on it directly. This contradicts `../architecture.md` §4 ("`Repo` is the only server-side store interface"), which holds only for the server's own tables.
- **The core calls back into the server synchronously.** `src/core/boards.ts` keeps a `WeakMap<Database, Access>`; core statements call the server's `Access`, which reads through `Repo`. An async server core forces an async `Access`.
- **Correctness leans on a blocking transaction.** `repo.atomic` is `BEGIN IMMEDIATE` with a synchronous callback (`Sync<T>` makes a promise a type error). A hosted tool call is one such transaction (`hosted.ts` run). While it runs, nothing else in the process runs, so a transaction may read in-memory state (registry liveness, busy and inflight maps, delivery leases, BindGate, limiters, a session's `holds`) and nothing can change it before commit. Several sites (the `no await since` comments among them) depend on this.
- **Read-then-write invariants rely on the single writer.** At least: alias takeover in `holdAlias`, `bindNow`'s exclusivity check against another user's tools-only `writes_as` (`aliasUser`), the alias cap (`alias_cap.ts` says so), `teams.create`, `guardLastOwner`, OAuth `redeemCode` and `rotateRefresh` replay detection, the `createRequest` capacity count, the attachment quota, `dedupWrite`, `claim()` (`core/claims.ts`), and the hosted `full()` capacity check. Postgres's default READ COMMITTED serializes none of them.
- **`afterCommit` and the auth cache are SQLite mechanisms.** `afterCommit` monkey-patches `db.transaction`; the auth cache is keyed on TEMP triggers plus `PRAGMA data_version`, which also sees another connection's commits (an operator's `sqlite3`, `scripts/loadtest.ts` seeding users and tokens), and `authRead` pins one generation in a single `pinned` variable that assumes one auth read at a time (#881).
- **The driver.** `Bun.SQL` (built in; no dependency) speaks Postgres. Probed on Bun 1.4.4 against `postgres:18`: `int8` returns as a string (or `BigInt` with `bigint: true`; no per-type parser, and `BigInt` breaks `JSON.stringify`); SQLSTATE is in the error's `errno` (`40001`, `23505`), not `code`; `sql.begin(...)` gives a transaction handle; `RETURNING` and `ON CONFLICT ... DO NOTHING` behave as in Postgres.

## Decisions

### D1. Fork the server core; local keeps its own (maintainer, 2026-11-14)

The server gets its own async core on Postgres under `src/server/store/`. `src/core/` stays synchronous SQLite for local mode and loses its server callers. Drift between the two is caught by a black-box conformance suite on the tool surface run against both modes, not by sharing code. The server's copies of board, claim, binding, session-end, delegation and attachment logic are ports, so a later fix to one side names the other in its PR (the conformance suite is the backstop).

### D2. Transactions are explicit values

- `type Read` is a statement handle (the pool, or a transaction); `type Tx extends Read` adds `afterCommit(fn)` and `savepoint(fn)`. Every store function that writes takes a `Tx`; one that only reads takes a `Read`. No module holds an ambient pool it can query behind a caller's transaction: a stray pool query inside a transaction runs outside it, and at pool exhaustion it deadlocks against the transaction holding the last connection.
- `atomic(fn)` opens a transaction and passes the `Tx`. A nested `atomic` inside one is a type error; nesting goes through `tx.savepoint`.
- `afterCommit` callbacks live on the `Tx` and run in registration order after `COMMIT` resolves, never on rollback, and the synchronous part of each runs before the write queue (D4) is released. So the next queued transaction sees every in-memory effect of the last, as it does today when effects flush before anything else runs. This replaces the `db.transaction` monkey-patch.
- `Access` (the authorization seam) becomes async and takes the caller's `Read`, so a policy read inside a transaction sees that transaction. This lands with the core's server-side ports (P3): until then the server still calls the synchronous `src/core/`, whose statements call `Access` synchronously.

### D3. Database invariants move into SQL

Each read-then-write invariant becomes one statement or a lock on a row the invariant hangs off, so it holds at any isolation level and on any number of pods:

| Invariant | Form |
|---|---|
| OAuth code single use; refresh-token rotation replay | a code is spent when its `grant_id` is set: `UPDATE oauth_codes SET grant_id = $g WHERE hash = $h AND grant_id IS NULL RETURNING ...`, and rotation the same on the refresh token's spent marker; zero rows means replay, and the replay path revokes the grant |
| Alias takeover (`holdAlias`), `claim()` | `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE <the takeover is allowed> RETURNING ...`: zero rows means held |
| An alias is held or written as by one user (`bindNow`'s `aliasUser` check; a tools-only root registering `writes_as`) | both paths `SELECT ... FOR UPDATE` the alias row before checking the other |
| Write dedup (`dedupWrite`) | insert the receipt first (`ON CONFLICT DO NOTHING RETURNING`); zero rows means a duplicate. A duplicate reads the stored result, unless its message was retracted (#306): then a conditional `UPDATE` on that receipt replaces it, the write goes out fresh and `request.receipt_stale` is audited, as today. `resend: true` skips the receipt check, as today |
| Principal names unique across users, teams and services (`teams.create`) | `principals.name` is already `UNIQUE`; the store relies on it instead of a prior read, and `23505` on that constraint maps to `PrincipalTaken` |
| Count caps: alias cap per scope, OAuth request capacity, attachment quota per user, hosted `full()` | `SELECT ... FOR UPDATE` on the parent row (the scope, the user, the server's capacity row), then count and insert |
| A team keeps an owner (`guardLastOwner`) | `FOR UPDATE` on the team row, then count owners |

`MAX_HOLDS` counts a session's in-memory `holds`, so the write queue covers it until Stage 4 moves holds out of process.

These forms also run on SQLite except `FOR UPDATE`, which SQLite's single writer makes unnecessary. The server-only sites (OAuth, `dedupWrite`, `teams.create`, `guardLastOwner`, the alias cap, `createRequest`, `full()`) take them before Postgres does (P2 below). The shared-core sites (`holdAlias`, `claim()`, the attachment quota) take them in the server's ports (P3), so local mode's core is untouched.

Isolation stays READ COMMITTED. SERIALIZABLE everywhere would turn every conflict into a retry of a whole tool call, whose in-memory side effects then need making re-runnable, for no gain at one pod.

### D4. In-memory state: one write queue until Stage 4

Stage 3 is one server pod. Once statements are awaited, other requests run between them, so a transaction that reads the registry, a lease map, BindGate or a limiter can see it change before commit. SERIALIZABLE does not cover memory, and an advisory lock helps only if every in-memory mutator takes it.

- Every write transaction runs through one in-process async queue (a mutex). In-memory state a transaction reads is mutated only inside a queued transaction or its `afterCommit`. That restores today's guarantee, "nothing else writes while I'm in a transaction", without depending on the event loop being blocked.
- A transaction body awaits only its own statements: no network, no blob I/O, no timers, no hooks. A blob `put` already happens outside the row's transaction (`core/attachments.ts`) and stays that way. A test enforces this (a queued body that awaits anything other than its `Tx` fails).
- Reads run concurrently on the pool, outside the queue.
- Granularity is measured, not guessed: the vertical slice (P4) runs `scripts/loadtest.ts` against Postgres. Narrow to queues keyed by session or scope only if the 1,000-session p99 < 100 ms bar fails. One global queue also rules out deadlocks among the server's own transactions.
- Stage 4 (#808) externalizes this state (leases, issued sets, wake fan-out); the queue is the thing it replaces, which is why D3 does not lean on it.

### D5. Hot reads stay in process

`authRead` runs per tool call and once a second per open stream: at the Stage 1 load about 1,000 checks a second, which as round trips would dominate. Principle 11 still binds: no cache outlives a revocation.

- **The generation.** An in-process counter, bumped by the store in `afterCommit` (before the queue is released, D2) on every write to `oauth_tokens`, `oauth_grants` and `users`. Writers outside the process exist (an operator's `psql` disable, `scripts/loadtest.ts` seeding a live server), so a statement trigger on those tables also issues `NOTIFY gb_auth`, and the server's `LISTEN` connection bumps the counter on each notification. An outside write takes effect when its notification arrives, after commit; the process's own writes take effect before the next queued transaction.
- **A fill can't race a bump.** A cache entry records the generation read before its database read, and is stored only if the counter still has that value after the read resolves. A read that straddles a bump returns its result uncached.
- **No shared pin.** Each `authRead` carries its generation in its own scope, not in one module variable (`pinned`, #881), because async auth reads overlap.
- If the `LISTEN` connection drops, the cache is disabled (every check reads the database) until it reconnects, so a lost notification can't leave a revoked token cached.

Stage 4 keeps this shape across pods: every pod listens.

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

1. **P1, the async seam on SQLite.** `src/server/store/` with D2's types over the existing SQLite code, the write queue (D4) and explicit `afterCommit`. Reads use a second SQLite connection, because a read on the writer's connection during a queued transaction would see its uncommitted rows. The router (`routeReads`, `src/core/sqlite.ts`) picks per call: the writer inside a transaction or for any write or connection-local SQL (`temp.`, pragmas), the read-only reader otherwise; a write it misses throws `SQLITE_READONLY` on the reader rather than misrouting. A second connection to `:memory:` is a separate, empty database, so `TestServer` and the tests that open `":memory:"` move to a file in a scratch directory. Behaviour-preserving: today's suite passes unchanged in meaning. This is where in-memory races first become possible, so it lands with D4's queue, not after it. The queue owns the writer connection: a write, or a transaction opened, outside the body that holds it is refused (`ownWriter`, `src/core/sqlite.ts`; `assertMine`, `src/server/store/queue.ts`), so a `write()` body may await between statements and nothing else touches its open transaction meanwhile. One hole stays open until the async `Repo` (P1c) passes a `Tx` to each store method and deletes the ambient writer: a timer or un-awaited promise a body starts inherits its ownership. D4's "a body awaits only its own statements" forbids starting one, and its test lands with P1c too.
   - **P1c order.** Store functions take their handle as an explicit first parameter (`repo.users.findById(r, id)`: a `Tx` for writes, a `Read` for reads), not handle-bound views. A store method can't go async before its callers, and before P1c-3 every `application.*` operation ran synchronously inside the hosted MCP write body, so P1c goes top-down: **P1c-1** the `Read`/`Tx` types (`src/server/store/tx.ts`); `write`/`post`/`writeNow` pass a live `Tx` to the body, closed when the body settles (a later use throws), and `repo.read` is the `Read`; no store changes. **P1c-2** the auth cache's generation bumped at commit (#996). **P1c-3** the application operations async, top-down: the tool-facing ones (`call`, `send`, `delegate`, `history`, `thread`, `inbox`, `pending`, `replay`, `retract`, `acknowledgeDm`, `boardCatalog`, `boardSnapshot`), awaited by their callers: the tool calls inside their queued body (hosted `run`, Slack's `inWrite`), the reads outside one (a lease's `pending`, a Slack or test `replay`); `HostedStore.write` takes `Repo.write`'s async overload. Three groups stay synchronous for now. The receipts (`receiptDirect`, `receiptBoards`) are called from the Slack bridge's posted bodies, which can't await, so they go async with the messages and mail stores, which first need a posted body that can await. `canReceiveBoard` sits on the sync `Access` seam (P3). The `hosted*` lifecycle operations, called from hosted's own write bodies, go async with the hosted store. **P1c-4** the handle reaches the operations before any store takes one: a store read inside a transaction given only the pool `Read` would miss that transaction's own uncommitted rows on Postgres. The write operations (`call`, `send`, `delegate`, `retract`, `acknowledgeDm`) take the body's `Tx` first, the reads (`history`, `thread`, `inbox`, `pending`, `boardCatalog`, `boardSnapshot`) a `Read`; `replay` takes none (it only schedules `afterCommit`). Hosted `run`'s body gets `(session, tx)`; Slack's `inWrite`, the hosted resource routes (`resources.list`/`read`, run inside hosted `run`) and the test `seed()` pass theirs; a delivery lease's `pending`, read outside any transaction, passes `repo.read`. `pending` stays a read: the outbox rows `pendingFor` cleans for a board its reader can no longer see go through `repo.post` (`lostAck`). **P1c-5** the first leaf stores take the handle, still synchronous: `cursors` (`get`/`directFor` a `Read`, `advance` a `Tx`) and `writeReceipts` (`find`/`refExists` a `Read`, the writes a `Tx`). The operations pass theirs down (`handleSend`/`handleDelegate`/`handleCall`/`handleBoardPost` → `writeOnce` → `dedupWrite`; `handleRetract`, `handleHistory`), `receiptDirect` takes the `Tx` of the body it runs in (a delivery receipt's, a Slack receipt's posted body), and a lease receipt's `pending` reads on that `Tx`, not the pool. They go async with the async `Repo`. `principals.findByName` waits for the `Access` seam (its callers are `authorize` and alias scoping), and `audit` (a hundred `writeAudit` callers, most in posted bodies) for its own slice. **P1c-6** `sessions` takes the handle: `create`, `revoke`, `revokeAllForUser`, `revokeDev` and `touch` a `Tx`, `findByTokenHash` and `findById` a `Read`. Token verification runs before any body and reads on `repo.read`; dev sign-in, logout, admin revoke-all, the posted last-used touch and startup's dev-session revoke pass their body's `Tx`. `revokeAllForUser` ends the user's hosted sessions through the hosted store, which keeps the ambient writer until its slice. **P1c-7+** the remaining stores per module, each taking the handle (leaf stores; users and OAuth; hosted, with #998; aliases and the resolver; teams; messages and mail; Slack), then the ambient writer is deleted and D4's await test lands.
   - **The synchronous `Access` seam.** Until async `Access` (P3), the reads it reaches (`serverAccess`, `src/server/access.ts`; `src/server/policy.ts`) keep a synchronous form beside the async one, which wraps it: `principals.findByName`, `teams.{findByName,isMember,isOwner,listForUser,shareCollaborative,shareDelegating}`, `users.findByEmail`, `aliases.{find,findAllByName}`, `resolver.principalOf`.
2. **P2, the server-only invariants into SQL (D3)** on SQLite. Today's suite covers behaviour; SQLite serializes these transactions, so no test there can fail on the old read-then-write form.
3. **P3, the Postgres store** behind the same interface: DDL, migrations, row mappers, the core's server-side ports with their D3 forms, and async `Access`. The server picks Postgres when `GRAYBOARD_DATABASE_URL` is set; unreleased until P5. Each D3 form gets a test on Postgres that runs two callers in separate transactions with the write queue bypassed, interleaved at a `testPause` point, and fails if the form reverts to read-then-write.
4. **P4, the vertical slice measured**: hosted tool call → `board_post`, bind, `claim()` on Postgres under `scripts/loadtest.ts`, whose seeding of users and tokens moves from `openDatabase` and `bun:sqlite` to the store; tune queue granularity (D4) if the bar fails.
5. **P5, cutover.** `grayboard-server import-sqlite <path>` copies a live server database into an empty Postgres (one-time, offline, server stopped). The release that ships it deletes the SQLite server store; `GRAYBOARD_DB_PATH` on the server becomes a startup error naming the import. `deploy/backup.sh` (a nightly `sqlite3 .backup`) is replaced in the same release, or it would keep reporting success on a frozen file. P5 does not merge until CI runs a Postgres service container: after it, the server suite has no SQLite store to fall back on. The v1.0.0 upgrade floor retires for the server here (maintainer, 2026-11-14), replaced by "the current release's server database imports" and, for local mode, "the current release's database opens under HEAD".

The two stores coexist only between P3 and P5, inside the repo, never in a release: not a shim (principle 12).

### D9. Tests

- **Isolation by template database.** A suite-level setup creates `gb_template` once (migrations applied); each test's server gets `CREATE DATABASE ... TEMPLATE gb_template`, dropped after. `TestServer` and `ServerProcess` take the URL; `GRAYBOARD_TEST_PG_URL` names the cluster. Until CI has a Postgres service container (a `.github/workflows/` change, the maintainer's batched push), Postgres-backed tests skip when the variable is unset, and the SQLite store keeps the suite's coverage. Once CI has the container, an unset variable under `CI` fails the suite instead of skipping, so a lost service can't turn the server tests silently green.
- **Helpers go through the store.** `hostedRowCount`, `accessAudits`, `busRows`-style readers become async store reads, so tests stop issuing SQL. Test files that run SQL directly are ported with the module they test, not up front.
- **Conformance suite (D1)**: tool-surface scenarios (DM, board, claim, bind, delegate, attachments, session end) run against local mode and the hosted server; it starts small in P3 and grows with each port.
- **Concurrency tests** force interleavings at `testPause` points (P3), never sleeps.

## Open questions

- **Postgres major.** The RDS major the platform runs; CI and local tests pin the same image. `postgres:18` until the platform answers.
- **Pool size.** `Bun.SQL` defaults to 10. With D4's single write queue one connection writes at a time, so the pool serves reads; D5's `LISTEN` holds one more connection of its own. Size it from P4's measurements, against the RDS instance's `max_connections`.
- **Inspector and usage scripts.** `scripts/inspect.ts` (a released binary) and `scripts/usage.ts` read a server's SQLite file. At P5 they either read Postgres or drop their server views; decide before the cutover release.
- **Import window.** P5's import is offline: the team server is down for the copy. The live database is small, but measure it before choosing offline over dual-write.

## Not in scope

HA, multiple pods, blobs in object storage, and externalized hub state are Stage 4 (#808). This design keeps them possible: D3's invariants hold across pods, D4 names exactly what Stage 4 replaces, and D5's notifications already reach every pod.
