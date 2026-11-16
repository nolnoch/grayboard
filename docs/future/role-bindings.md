# Role bindings

```doc-meta
owns: the design of runtime role bindings on the server (#927): the `role_bindings` table, the roles `org_admin`, `team_owner` and `service_invoke`, the policy rules that read it, the admin role routes and CLI
invariants: authority is "a row exists", read on every decision, never cached (principle 11); `GRAYBOARD_ADMINS` emails are `org_admin` with no row and are never written to the table; principal and scope are `principals.id` foreign keys, never an email or a name; every binding deletion (revoke, member removal) goes through the store's revoke and writes a `role.revoked` row carrying the whole binding; a grant or revoke re-checks the granter's authority in its own write; a team owner is a member of that team; a rule name is a closed set and the binding id travels beside it; `org_admin` adds no messaging or directory power
code-pointers: src/server/policy.ts (authorize, recordDecision, isAdmin, canAdmin), src/server/http.ts (the /api/admin gate, ownedTeam, managedTeam, teamAdd), src/server/db.ts (principals, team_members, OWNER_SQL, guardLastOwner, seedSchema), src/server/audit.ts, src/server/config.ts (admins), src/cli/cli.ts (adminCmd, teamCmd), tests/integration/authz_decision.test.ts
companions: postgres-server.md (the storage interface this is written against: D2, D3, D5, D7), ../server-access.md (the authorization seam and teams, which take the as-built facts), ../vision.md (principles 4, 8, 9, 11, 12, 13), ../parity.md (the row the build adds)
trigger: Postgres P1c merged (`Repo` methods async, #807 Stage 3); #270's `service.invoke` builds on this
last-verified: 2026-11-15
```

## Problem

Server admin authority is the `GRAYBOARD_ADMINS` list (rule `admin.env`): one level, changed by redeploy. The pilot needs authority granted and revoked at runtime and audited, and #270 needs a home for `service.invoke` that isn't another env list. #927 fixes the table's columns, the three roles, the CLI verbs, the bootstrap rule and local mode as n/a; this doc decides the rest.

Facts in the code that shape it:

- **Team ownership already exists.** `team_members.role` (`owner`/`member`, security audit F-02) decides `team.manage` under rule `team.owner`; owners appoint owners with `team add --role owner`; `guardLastOwner` protects the last one; a null role reads as owner for the team's creator (`OWNER_SQL`). #927's `team_owner` names the same thing.
- **Callers compare rule strings.** `managedTeam` and `ownedTeam` (`src/server/http.ts`) set `as_admin` from `d.rule === "admin.env"`.
- **The `admin` verb carries only an email**, and `canAdmin` calls `authorize` with no `Repo`.
- **Every role decision is on a CLI HTTP route.** Admin and team verbs are decided only in `src/server/http.ts`; no hosted MCP tool call reads a role today.
- **`principals` already spans the kinds.** Every user and team has a row (inserted with it, and seeded on open); `kind = 'service'` is reserved for #270, whose service principals are also `users` rows (#284 decision 5). Foreign keys are enforced (`PRAGMA foreign_keys = ON`).
- **`access_log` is pruned** at the audit retention window; `authz.decision` rows go with it.
- **Nothing deletes a team, a user or a principal.**

## Decisions

### R1. Principal and granter are `principals.id`

`role_bindings.principal_id` and `granted_by` reference `principals(id)`.

- Not email: #927 rules it out, and an email is a name, not an account.
- Not `users.idp_subject` (with `idp_issuer`, #928; [../architecture.md](../architecture.md) §3): it is null for dev-auth users and for anyone not signed in since F-13, it is per IdP, and `admin unlink-idp` clears it.
- Not `users.id`: it works for users and services but can never name a team, and a team as the holder of `service_invoke` ("every member of `eng` may invoke `ingest`") is the likely #270 grant. `principals.id` covers it with no schema change.
- Not a typed `kind:id` string: it is a foreign key without the database's enforcement. `principals.kind` is the type.
- A service principal fits before #270 exists because its `principals` row is the key; nothing here waits on its credential.

The API and CLI name a principal by `principals.name` (a user's email, a team's or service's name: one namespace), resolved to the id inside the grant's statement. A name with no row is refused 404, as `teamAdd` refuses an email that never signed in: no binding is ever held for an account that doesn't exist. The one exception runs first: revoking `org_admin` from a `GRAYBOARD_ADMINS` email is decided by R4 (409) whether or not the email has a row.

Which kinds may hold which role is code, in one table in `policy.ts` (role → scope kind, allowed holder kinds): `org_admin` and `team_owner` are held by users only; `service_invoke`'s holder kinds are #270's to set.

### R2. Scope is a nullable `principals.id`

`scope_id` references `principals(id)`: null for the org (`org_admin`), the team's principal row for `team_owner`, the service's for `service_invoke`. Teams and services are both principals, so one column covers both and the role fixes the kind.

- Not `ActScope`'s `(scope_kind, scope_ref)` text: a deleted team's name can be taken by a new team, and a name-keyed binding would then own the new one.
- **A dangling scope can't exist.** The foreign key is declared `ON DELETE RESTRICT` explicitly (the default, `NO ACTION`, behaves the same only while the key isn't deferred), not `CASCADE`: whoever adds team or service deletion must revoke the scope's bindings in the same transaction, each with its `role.revoked` row, or the delete fails. A cascade would remove authority with no audit row (principle 8).
- Uniqueness is two partial unique indexes, `(principal_id, role) WHERE scope_id IS NULL` and `(principal_id, role, scope_id) WHERE scope_id IS NOT NULL`, because a null never collides in a plain unique index on SQLite or Postgres. `idx_users_idp_identity` is the precedent for a partial unique index.
- A second index on `(scope_id, role)` serves "this team's owners" (R6's last-owner count, the roster).
- No `CHECK` on `role`: SQLite can't widen a `CHECK` additively, so a new role would break the additive rule. The role table in code validates; a row whose role the running code doesn't know grants nothing, because every lookup names its role.

### R3. Grant and revoke

- **Grant is one statement** (postgres-server.md D3): `INSERT ... SELECT` from `principals` for the holder and the scope, with the kind checks (and for `team_owner`, the membership check, R6) in its `WHERE`, `ON CONFLICT DO NOTHING RETURNING`. Zero rows means already held or a failed precondition; a follow-up read says which. A grant that is already held answers 200 with the existing binding and writes no `role.granted` row, as `teamAdd` does for an existing member.
- **The granter's authority is re-checked in the write.** The route's decision is read before the body is parsed and before the write commits, so a granter revoked in between would otherwise still land a grant (the race F-02 closed for team owners, which runtime revoke opens for admins). The grant's and revoke's `WHERE` also requires the granter's authority as of the write: for `org_admin` and an admin's `team_owner` grant, the granter is a bootstrap admin (checked in code: the env list doesn't change at runtime) or `EXISTS` an `org_admin` binding of theirs; for an owner's `team_owner` grant or revoke, `EXISTS` their `team_owner` binding on that team or an `org_admin` binding. Zero rows with the granter's authority gone answers 403, like the gate.
- **A grant can't race a member removal.** On Postgres at READ COMMITTED, a grant's membership check sees a row a concurrent removal is deleting, and the removal's binding delete can't see the grant's uncommitted row: the result would be an owner who isn't a member. So a `team_owner` grant takes `FOR SHARE` on the team's row before its insert, and member removal takes `FOR UPDATE` on it (which the last-owner guard, R6, takes anyway). On SQLite the single writer serializes them.
- **Revoke is a hard delete**: `DELETE ... RETURNING *`, and the `role.revoked` row's detail carries the whole binding (id, holder, role, scope, `granted_by`, `granted_at`). Reasons:
  - Authority stays "a row exists". With a soft delete every reader must add `revoked_at IS NULL`, and the one that forgets grants a revoked role.
  - Uniqueness stays the plain indexes of R2, and a re-grant is a new row with a new id.
  - Nothing is lost that a soft delete would keep usefully. A decision row naming binding N lives one retention window; the `role.revoked` row for N is written after every such decision and is self-contained, so N resolves for as long as any row names it. Ids are never reused (`AUTOINCREMENT`, and `GENERATED ALWAYS AS IDENTITY` on Postgres).
  - A soft-deleted row would sit outside the retention clock forever; retention is operator policy (principle 5).
- `role.granted` and `role.revoked` join `AuditAction`: actor the granter's user, target the holder's principal name, detail the binding id, role, scope name and both ids. Both are written in the transaction that changes the row.
- **`org_admin` may grant and revoke `org_admin`**, its own included. Otherwise only the env list makes admins, which is the redeploy #927 removes. There is no role above it to escalate to.
- **No last-`org_admin` guard.** The bootstrap list is the recovery path and exists for exactly this. A guard is a count-then-write invariant, which D3 requires as a lock on a parent row, and the org scope has none; adding a lock row to prevent a state the operator recovers from by setting one env var is not worth it. The revoke response says when no binding and no bootstrap admin remains, and the CLI prints it.

### R4. Bootstrap admins

- `GRAYBOARD_ADMINS` is checked first and decides with rule `admin.env`, reading nothing: a bootstrap admin keeps its powers when the table is empty, unreadable or wrong. A user who is both is decided by `admin.env`.
- Bootstrap admins are **never written to the table** (acceptance criterion 2 depends on it, and a written row would outlive the email's removal from the env).
- **`list` shows them**, as entries with no id and `source: "bootstrap"`, whether or not the email has signed in. A list of admins that omits some of them misleads the person auditing who holds the server.
- Revoking `org_admin` from a bootstrap email with no binding is refused 409, naming `GRAYBOARD_ADMINS`. With a binding, the row is deleted and the response says the env still makes them an admin.
- The `admin` deny's "no admins are configured on this server (GRAYBOARD_ADMINS)" text goes: it would need a count to stay true. The deny says the user is not an org admin.

### R5. Policy: the rule is a name, the binding rides beside it

- A role-based allow has a rule from a closed set, `role.org_admin` or `role.team_owner`, and `Decision` gains `binding?: number`. `recordDecision` writes it to the row's detail as `binding`, with `role` and `scope`.
- This departs from #927's wording ("records the binding id as the rule"). An id inside the rule string makes every rule value unique, which breaks grouping rows by rule and every `d.rule === ...` comparison. Acceptance criterion 3 asks that the row name the binding, which the detail does.
- `as_admin` in `managedTeam` and `ownedTeam` becomes "decided by `admin.env` or `role.org_admin`". Left as it is, an admin by binding who manages a team they aren't in would be audited as an ordinary owner.
- **A deny has no binding to name.** A deny by absence records the rule named for the role whose binding would have allowed it, and in the detail the role and scope: the `admin` deny's rule becomes `role.org_admin` (today `admin.env`), and `team.manage`'s non-owner deny becomes `role.team_owner` (today `team.owner`). The `team.member` not-found deny keeps its name. Tests that match today's deny rule names move with them.
- **`org_admin` takes exactly `admin.env`'s powers**: every `/api/admin/*` route, `team.read` on a team the caller isn't a member of, and `team.manage` on any team where the caller isn't an owner (a member who isn't an owner included, as `policy.ts` allows `admin.env` today). It keeps today's non-powers: no exemption on `msg.wake`, `delegate.to`, `alias.see` or `team.leave` (admin is a server role, not a messaging or directory grant, principle 9).
- The `admin` verb's request carries the user (id and email) so the rule can find the principal. `canAdmin` is deleted with its tests moved to `authorize` over a store: a role rule can't run without one.
- The binding read is one indexed lookup on the caller's `Read` or `Tx` (D2), made where `authorize` reads team membership, in whatever form those reads take after P1c.
- **A role-based `team.read` allow is recorded** (an admin, by env or binding, reading the roster of a team they aren't in). Today only its denies are; an exercise of admin authority is a decision row (principle 8). A member's read stays unrecorded.

### R6. `team_owner` replaces `team_members.role`

One concept gets one store. Team ownership moves to `role_bindings`; `team_members` keeps membership only.

- **What it takes over:** the `team.owner` allow in `team.manage`, so everything behind `ownedTeam`: adding and removing members, changing a member's role, setting the team's policy, deleting a team name. The rule is renamed `role.team_owner`, and its allow rows carry the binding.
- **An owner is a member.** The grant's `WHERE` requires the membership row (and takes R3's `FOR SHARE`). Removing a member (`team remove`, or `team leave`, both through `removeMember`) deletes their binding in the same transaction through the store's revoke, so it writes the `role.revoked` row with the whole binding and hits the last-owner guard: no binding is ever deleted without its audit row. So a non-member still reads 404 and no new path to a private team's roster opens. A non-member who should manage a team is added to it, or is an `org_admin`.
- **Owners still appoint owners.** `team add <team> <email> --role owner` and `--role member` stay, authorized by `team.manage`, and call the same store grant and revoke as the admin route. So the table has three writers for `team_owner`: team creation (`teamCreate` grants its creator `team_owner`, `granted_by` the creator, with its `role.granted` row, in the transaction that adds the membership; today's `addMember(..., "owner")`), an owner of that team, and an `org_admin`. `admin role grant team_owner` is the same grant with the membership precondition (409 naming `team add` when it fails).
- **Last owner** (`guardLastOwner`): unchanged in meaning, now a count of the team's bindings, in D3's form (`FOR UPDATE` on the team row, then count). It lives in the store's revoke, so both writers hit it.
- **Seed, once.** The open that creates `role_bindings` inserts a `team_owner` binding for every `team_members` row `OWNER_SQL` calls an owner, with `granted_by` null (the only null: "seeded") and `granted_at` the join time. It follows the alias seed's pattern in `seedSchema` and for its reason: a later seed would bring back a revoked ownership. This materializes the legacy null-role creator rule, so `OWNER_SQL` is deleted. A team with no owner after the seed stays the admins' to manage, as today.
- After the seed nothing reads or writes `team_members.role`. On SQLite the column stays (additive rule); the Postgres DDL omits it (D7). No dual write (principle 12), so a server rolled back to the previous release reads stale roles: the pre-upgrade snapshot is the way back.
- `team.role_changed` is no longer written; `role.granted` and `role.revoked` replace it, and `team.member_added` drops its `role` field.
- Why not a separate "may manage this team" grant beside the column: two stores would both be called team owner, the roster and `LastOwner` would count only one of them, and the only thing the binding would add is what an `org_admin` already does by `team add --role owner`.

### R7. `service_invoke`

- Direction: the holder is the invoker; the scope is the service's principal row.
- This change adds the role to the role table and nothing else: no verb, no rule, no check (principle 12: no surface without a caller). Until #270 creates a `kind = 'service'` principal, every grant is refused 404 on its scope, which the grant statement does unprompted.
- #270 owns the `service.invoke` verb, its holder kinds (R1), and its cost: it puts a role read on the hosted tool-call path (a post to a service's queue board), where it must stay one indexed lookup inside the call's transaction (principle 13).

### R8. No cache

Every decision reads the table. Principle 11 allows an indexed lookup per decision, and R5's reads happen only on CLI routes, at human rates. So a revoke governs the next request with no restart, and so does a row deleted by an operator's `psql`.

Nothing in a session holds a role: admin and team management are per-request HTTP, and ownership (unlike membership) backs no alias hold, so a revoke needs no `accessChanged`.

If #270's hot-path read fails the load budget, its cache joins D5's generation set and `NOTIFY` trigger, or an outside revoke is missed. That is #270's decision, on a measurement.

### R9. Schema on both stores

- **SQLite** (while it is the server's store): `CREATE TABLE IF NOT EXISTS role_bindings` and its indexes in the schema step of `src/server/db.ts`, inside `openSqlite`'s one transaction with the R6 seed. Nothing existing is altered, so every released database opens.
- **Postgres** (P3): the same table in the migration that creates the schema, ids and times as D6 says, without `team_members.role`.
- **P5's `import-sqlite`** copies `role_bindings` like any table. It starts from a database HEAD has opened (D7), so the seed has run and is not ported.
- The store functions (grant, revoke, held, list, owners of a team) are written once, against `Read` and `Tx`. Only the DDL exists twice, between P3 and P5.

### R10. Routes and CLI

- Three routes under `/api/admin/roles`: grant and revoke as `POST` with a JSON body, list as `GET`, in the style of the existing admin routes. Being under `/api/admin/` they inherit the existing gate and its decision row naming the route, so "behind `org_admin`" needs no second check.
- Grant and revoke name the binding by `{principal, role, scope?}` with names, not the id: the triple is what the operator knows and is unique (R2). The response carries the binding with its id.
- List filters by role, principal and scope, and pages by id with a bounded page size: an unfiltered list is O(the org's bindings), and a request stays O(its own state) (principle 13).
- CLI: `grayboard admin role grant|revoke <role> <principal> [--scope <name>]` and `grayboard admin role list`, thin over the routes like the other `admin` commands. One `--scope` flag, since the role fixes whether the name is a team or a service. `adminCmd`'s description stops saying "GRAYBOARD_ADMINS only".
- No MCP tool: an agent's context doesn't pay for an operator's command (principle 2).

### R11. Parity and owner docs

- The implementing PR adds one row to `../parity.md` (runtime role bindings and the admin role CLI) with every local cell n/a (`vision.md` §1: no authorization model with one user) and every hosted cell supported, with its evidence beside the other server-only grant rows. The capability is server-side HTTP and CLI, the same for every harness.
- As-built facts move to `../server-access.md` §1 (`admin`, Teams, Decision rows), `../architecture.md` (the table) and `docs/guide/server.md` (the env list as bootstrap, the commands); this file is then deleted.

## Gotchas

- **Bindings follow the `users` row.** `admin unlink-idp` hands the row, and with it every binding, team membership and bootstrap status, to the next account that signs in with the email. `disable-user` leaves bindings in place and inert (a disabled user can't authenticate); enabling restores them. Offboarding (#930) owns revoking them.
- **Deny rows are thinned** (`DENY_ROW_LIMIT`): past the burst a user's denies are counted in `authz.suppressed`, not written. "Every role-based deny writes a row" holds only under the burst.
- **`role.granted` for a seeded binding doesn't exist.** Its `role.revoked` row is still complete (R3).
- The R6 seed must run after the principals seed in `seedSchema`: it joins both users and teams to their principal rows.

## Tests, by acceptance criterion

All on `TestServer` with `accessAudits`, unless said.

1. **Granted through the CLI, admin without the env; revoked, refused, no restart.** A bootstrap admin grants `org_admin` to a user; that user's admin route answers 200 with rule `role.org_admin` and the binding id; after revoke the same route answers 403 on the same server object. A second case deletes the row with raw SQL on a second connection to the database, as an operator's `psql` would, and the next request is refused: this is the one that fails if a cache appears, including one the store's own revoke would invalidate. One `runCli` test against a `ServerProcess` drives grant, list and revoke through the real CLI.
2. **Bootstrap with an empty table.** `admins: [root]`, no bindings: an admin route answers 200 with rule `admin.env`; the table is still empty afterwards; `list` shows the bootstrap entry; revoking it is refused 409. A user both bootstrap and bound is decided by `admin.env`.
3. **Audit rows name the binding.** `role.granted` and `role.revoked` carry the id and the revoke row the whole binding; a repeated grant writes no second row; a role-based allow row carries `binding`; a deny row carries the role and scope looked for (kept under the deny burst); an admin's roster read of a team they aren't in writes an allow row, and their team changes carry `as_admin` whether the rule was `admin.env` or `role.org_admin`.
4. **`team_owner` on that team only.** A user with a binding on one team manages it (200, `role.team_owner`); on a second team where they are a member they get 403, and on a third they aren't in, 404. Around it: a grant to a non-member is refused; removing a member, and a member leaving, deletes their binding and writes `role.revoked`; the last owner can't be revoked by either writer while members remain; `team add --role owner` by an owner writes a binding with that owner as `granted_by`; creating a team gives its creator a binding (and the creator then manages it: 200 on `team add`).

Also:

- **Seed and upgrade.** `tests/integration/upgrade.test.ts`'s release database, given an explicit owner and a null-role creator, opens with a binding for each; a binding revoked afterwards is not back after a second open.
- **`policy.ts` unit tests** for each rule, and `policy.test.ts`'s seam check still passes with `canAdmin` gone.
- **`service_invoke`**: a grant is refused 404 while no service principal exists.
- **Stale authority.** A `testPause` point between the gate's decision and the grant's write: the granter's `org_admin` is revoked while the request is paused, and the grant is refused 403 with no binding written. The same for an owner demoted between `team.manage`'s decision and a `team add --role owner` write.
- **Postgres (P3)**: the grant and the last-owner count each get D9's interleaving test (two transactions, write queue bypassed, a `testPause` point), failing if either reverts to read-then-write; and a `team_owner` grant interleaved with that member's removal ends with no binding for a non-member, failing if the grant's `FOR SHARE` is dropped.

## Where #927 and the code disagree

- **`team_owner` is not new** (R6). The issue reads as if team ownership didn't exist; the build is a move, with a seed, not an addition.
- **"Behind `org_admin`"** holds for the admin routes, but team owners also grant and revoke `team_owner` through `team add`, and team creation grants it to the creator (R6).
- **"Records the binding id as the rule"** conflicts with rule-string comparisons in `http.ts` (R5).
- **"Every role-based allow or deny"** (criterion 3): a deny has no binding, denies are thinned, and `team.read` allows weren't recorded at all (R5, Gotchas).
- **"Written once"**: the store code is; the DDL is written for SQLite and again for Postgres unless this lands after P3 (R9).
- **`service_invoke` "to start"**: nothing can be granted or checked until #270 (R7).

## Open questions

Sent to the maintainer with defaults; with no answer, the defaults are the design. A reply reopens the one it names.

- **R6's scope.** Moving ownership into the table is larger than the issue's text. The fallback is a `team_owner` binding that only lets a non-member manage one team, leaving `team_members.role` alone; it is smaller and leaves two stores of "owner". Default: the move (R6).
- **Landing before or after P3.** After P1c and before P3 costs a second DDL (R9); after P3 delays #270, which is on the pilot gate. Default: before P3.
- **Hand-on of a bound account.** Whether `admin unlink-idp` should refuse a user who holds `org_admin` until it is revoked, rather than leaving it to #930. Default: left to #930.
