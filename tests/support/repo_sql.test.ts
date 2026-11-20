// repo_sql.ts, audit.ts and hosted_rows.ts on each backend (#807 P3 C11c): the same SQL, the same rows.
import { describe, expect, test } from "bun:test";
import { accessAudits, auditOrigins } from "./audit.ts";
import { hostedRowCount } from "./hosted_rows.ts";
import { exec, execOn, pgText, row, rows, txSpy } from "./repo_sql.ts";
import { seed } from "./seed.ts";
import { TestServer } from "./server.ts";

test("pgText numbers the placeholders outside quoted strings and identifiers", () => {
  expect(pgText("SELECT ? AS a, '?' AS \"b?\", ? AS c")).toBe("SELECT $1 AS a, '?' AS \"b?\", $2 AS c");
  expect(() => pgText("SELECT 'x")).toThrow("unterminated");
});

const backends: ("sqlite" | "pg")[] = ["sqlite", ...(process.env.GRAYBOARD_TEST_PG_URL ? ["pg" as const] : [])];

describe.each(backends)("on %s", (backend) => {
  test("rows read as SQLite's: int8 a number, boolean 1/0, json text; row is null when none", async () => {
    await using srv = await TestServer.open({}, { backend });
    await srv.app.ready;
    await exec(srv, "INSERT INTO access_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", 5, "a@example.com", "test.thing", "t", JSON.stringify({ k: 1 }));
    expect(await rows(srv, "SELECT at, actor, count(*) OVER () AS n FROM access_log WHERE action = ?", "test.thing")).toEqual([{ at: 5, actor: "a@example.com", n: 1 }]);
    const detail = (await row<{ detail: string }>(srv, "SELECT detail FROM access_log WHERE action = 'test.thing'"))!.detail;
    expect(JSON.parse(detail)).toEqual({ k: 1 });
    expect(await row(srv.app.repo, "SELECT 1 AS one FROM access_log WHERE action = ?", "nothing")).toBeNull();
    expect(await row(srv.app, "SELECT (1 = 1) AS t, (1 = 0) AS f")).toEqual({ t: 1, f: 0 });
    expect(await accessAudits(srv, "test.thing")).toEqual([{ at: 5, actor: "a@example.com", target: "t", detail: { k: 1 } }]);
    expect(await auditOrigins(srv, "test.thing")).toEqual([{ ip: null, ua: null, client_id: null }]);
    expect(await hostedRowCount(srv)).toBe(0);
  });

  test("execOn writes on a body's Tx, and reads there see it before the commit", async () => {
    await using srv = await TestServer.open({}, { backend });
    await srv.app.ready;
    const seen = await seed(srv.app.repo, async tx => {
      await execOn(tx, "INSERT INTO access_log (at, action) VALUES (?, ?)", 1, "test.in_tx");
      return (await rows(tx, "SELECT action FROM access_log WHERE action = ?", "test.in_tx")).length;
    });
    expect(seen).toBe(1);
    expect(await rows(srv, "SELECT action FROM access_log WHERE action = 'test.in_tx'")).toEqual([{ action: "test.in_tx" }]);
  });

  test("txSpy is open while a write, post or hosted.write body runs, and restores them", async () => {
    await using srv = await TestServer.open({}, { backend });
    await srv.app.ready;
    const repo = srv.app.repo;
    const { write, post } = repo, hostedWrite = repo.hosted.write;
    const spy = txSpy(srv);
    const seen: boolean[] = [spy.open];
    await repo.write(() => { seen.push(spy.open); });
    await repo.write(async () => { await Bun.sleep(1); seen.push(spy.open); });
    await repo.hosted.write(() => { seen.push(spy.open); });
    await new Promise<void>((resolve) => repo.post(() => { seen.push(spy.open); }, () => resolve()));
    await expect(repo.write(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    seen.push(spy.open);
    spy.restore();
    expect(seen).toEqual([false, true, true, true, true, false]);
    expect([repo.write, repo.post, repo.hosted.write]).toEqual([write, post, hostedWrite]);
  });
});
