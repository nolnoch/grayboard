// #807 P3 C11a: the Postgres Repo's composition (pg_repo.ts makePgRepo) behind a real server: its close (the pool and
// the auth LISTEN, awaited by app.stop) and its hosted change notices (store/notices.ts over each body's Tx). The
// store groups' own behaviour is their contracts'; what's pinned here is the wiring. Without GRAYBOARD_TEST_PG_URL they
// skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePg, pgDatabase } from "../../tests/support/pg.ts";
import { pgServers } from "../../tests/support/pg_server.ts";
import { until } from "../../tests/support/until.ts";
import type { HostedSession } from "./hosted-types.ts";
import { makePgRepo } from "./pg_repo.ts";

setDefaultTimeout(30_000);

const LIMITS = { hostedRequestLimit: { burst: 10_000, perSec: 10_000 } };

describePg("the Postgres Repo behind a server", () => {
  // Mutations: app.stop not awaiting repo.close (stop resolves before close settles); close skipping the generation's
  // close (the gb-test-a-listen backend stays); a second pool on another clock is the next test's.
  test("app.stop resolves only once the Repo has closed: its pool and its auth LISTEN connection are gone", async () => {
    await using pg = await pgServers(1, { overrides: LIMITS });
    const [srv] = pg.servers;
    const repo = srv!.app.repo;
    const backends = async () => (await pg.db.sql`SELECT application_name FROM pg_stat_activity
      WHERE datname = ${pg.db.name} AND application_name LIKE 'gb-test-a%' ORDER BY 1`).map((r: { application_name: string }) => r.application_name);
    // Open: the LISTEN connection, and the pool once a request has used it (the migration's connection closed).
    await (await srv!.hosted("you@example.com", "be")).call("whoami");
    expect(await backends()).toEqual(expect.arrayContaining(["gb-test-a", "gb-test-a-listen"]));
    expect(await backends()).not.toContain("gb-test-a-migrate");
    let closed = false;
    const close = repo.close.bind(repo);
    repo.close = async () => { await close(); closed = true; };
    await srv!.stop();
    expect(closed).toBe(true);
    await until(async () => (await backends()).length === 0 || undefined, 3000, "the server's pool and LISTEN backends to exit after stop");
  });

  // Mutation: any group composed on its own clock (Date.now) instead of the Repo's. Each write or read here takes its
  // time from the store's clock, not from its caller (the server's own Date.now stamps are #1390's).
  test("every clock-taking group reads the Repo's clock", async () => {
    const T = 1_900_000_000_000;
    await using db = await pgDatabase({ max: 2 });
    const blobDir = mkdtempSync(join(tmpdir(), "gb-pg-blobs-"));
    const repo = await makePgRepo(db.url, { blobDir, now: () => T, applicationName: "gb-test-clock", max: 2 });
    try {
      const sql = db.sql;
      const userId = await repo.write(async tx => (await repo.users.upsertByEmail(tx, "you@example.com", null)).id);
      await repo.write(async tx => {
        await repo.aliases.create(tx, { scope_kind: "person", scope_ref: "you@example.com", name: "be" }, "you@example.com");
        await repo.messages.insert(tx, "you@example.com/be", "user", "you@example.com/be", "note", null);
        await repo.boards.ensure(tx, "general", "p", null, "you@example.com/be");
        await repo.bindings.log(tx, "id:x", "be", "bound");
        await repo.slack.link(tx, userId, "SU1", "D1");
      });
      const one = async (q: Promise<{ t: unknown }[]>) => Number((await q)[0]?.t);
      expect({
        identity: await one(sql`SELECT created_at AS t FROM users WHERE id = ${userId}`),
        aliases: await one(sql`SELECT created_at AS t FROM aliases WHERE address = 'you@example.com/be'`),
        messages: await one(sql`SELECT created_at AS t FROM messages WHERE body = 'note'`),
        boards: await one(sql`SELECT created_at AS t FROM boards WHERE name = 'general'`),
        bindings: await one(sql`SELECT at AS t FROM binding_events WHERE session_id = 'id:x'`),
        slack: await one(sql`SELECT linked_at AS t FROM slack_links WHERE user_id = ${userId}`),
      }).toEqual({ identity: T, aliases: T, messages: T, boards: T, bindings: T, slack: T });
      // claims.list keeps what's live at the clock: lapsed at T, live on the wall clock.
      await sql`INSERT INTO claims (key, holder, note, board, acquired_at, expires_at) VALUES
        ('ticket:lapsed', 'you@example.com/be', 'n', NULL, 0, ${T - 1}), ('ticket:live', 'you@example.com/be', 'n', NULL, 0, ${T + 1})`;
      expect((await repo.claims.list(repo.read, "ticket:")).map(c => c.key)).toEqual(["ticket:live"]);
      expect(repo.now()).toBe(T);
    } finally {
      await repo.close();
      rmSync(blobDir, { recursive: true, force: true });
    }
  });

  // Mutation: the notices' defer a no-op on Postgres (no observer hears a commit).
  test("hosted notices: a marked write's id and facts after its commit, none on a rollback, null for a revoke", async () => {
    await using pg = await pgServers(1, { overrides: LIMITS });
    const srv = pg.servers[0]!;
    const repo = srv.app.repo;
    await srv.hosted("you@example.com", "be");
    const [row] = await repo.hosted.all(repo.read);
    const id = row!.session_id;
    const heard: { changed: string | null; place?: string | null }[] = [];
    const off = repo.hosted.subscribe<HostedSession | undefined>((changed, facts) => {
      // Only this test's own writes: the server's sessions write too (touches don't notify, binds do).
      if (changed === id || changed === null) heard.push({ changed, ...(facts ? { place: facts.place } : {}) });
    }, (tx, at) => repo.hosted.get(tx, at));
    try {
      await repo.write(tx => repo.hosted.update(tx, id, { place: "here" }));
      await until(() => heard.find(h => h.place === "here"), 2000, "the marked update's notice with its facts");
      expect(heard).toContainEqual({ changed: id, place: "here" });
      heard.length = 0;
      await expect(repo.write(async tx => { await repo.hosted.update(tx, id, { place: "never" }); throw new Error("rolled back"); })).rejects.toThrow("rolled back");
      // A revoke notifies null whatever it revoked (an unknown token here, so the session stays signed in).
      await repo.write(tx => repo.oauth.revokeToken(tx, "no-such-token", "no-such-client", repo.now()));
      await until(() => heard.find(h => h.changed === null), 2000, "the revoke's null notice");
      // The rollback told nothing, and its write left nothing: the revoke's notice is the only one since.
      expect(heard.filter(h => h.place === "never")).toEqual([]);
      expect(heard.filter(h => h.changed === null)).toEqual([{ changed: null }]);
    } finally { off(); }
  });
});
