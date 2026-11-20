// #807 P3 C11b: TestServer's store. On pg each server gets a database of its own, kept across a restart and dropped by
// the final stop; describeSqlite and testSqlite skip on pg and say so.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePg, pgDatabase, PG_URL, pgUrl } from "./pg.ts";
import { ServerProcess, TestServer } from "./server.ts";

const ROOT = join(import.meta.dir, "../..");

async function exists(datname: string): Promise<boolean> {
  const admin = new Bun.SQL(PG_URL!);
  try { return (await admin`SELECT 1 FROM pg_database WHERE datname = ${datname}`).length > 0; } finally { await admin.close(); }
}
const dbName = (srv: TestServer) => new URL((srv.config.store as { url: string }).url).pathname.slice(1);

test("on sqlite a restart keeps the file and the dir; the final stop removes them", async () => {
  const first = await TestServer.open({}, { backend: "sqlite" });
  await first.login("alice@example.com");
  const path = first.dbPath;
  const srv = await first.restart();
  try {
    expect(srv.dbPath).toBe(path);
    expect(srv.dir).toBe(first.dir);
    expect(await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com")).toMatchObject({ email: "alice@example.com" });
    // A server's store passes on once.
    await expect(TestServer.open({}, { reuse: first })).rejects.toThrow("reuse takes a server stopped with stop({ keep: true })");
  } finally {
    await srv.stop();
  }
  expect(existsSync(srv.dir)).toBe(false);
});

describePg("TestServer on pg", () => {
  test("a server gets its own database, a restart reuses it, and the final stop drops it", async () => {
    const first = await TestServer.open({}, { backend: "pg" });
    const other = await TestServer.open({}, { backend: "pg" });
    const name = dbName(first);
    let srv: TestServer | undefined;
    try {
      expect(dbName(other)).not.toBe(name);
      expect(() => first.dbPath).toThrow("this server is on Postgres");
      await first.login("alice@example.com");
      srv = await first.restart();
      expect(dbName(srv)).toBe(name);
      expect(await exists(name)).toBe(true);
      // The row the first server wrote is there: the same database, not a fresh clone.
      expect(await srv.app.repo.users.findByEmail(srv.app.repo.read, "alice@example.com")).toMatchObject({ email: "alice@example.com" });
      // The first server's later stop doesn't drop what it handed over.
      await first.stop();
      expect(await exists(name)).toBe(true);
    } finally {
      await srv?.stop();
      await other.stop();
    }
    expect(await exists(name)).toBe(false);
    expect(await exists(dbName(other))).toBe(false);
  });

  test("the Postgres Repo takes the config's attachment limits and quota", async () => {
    const srv = await TestServer.open({ attachmentLimits: { file: 16, total: 32 }, attachmentUserQuota: 64 }, { backend: "pg" });
    try {
      expect(srv.config.store.kind).toBe("postgres");
      expect(srv.app.repo.attachmentLimits).toEqual({ file: 16, total: 32 });
      expect(srv.app.repo.attachmentUserQuota).toBe(64);
    } finally {
      await srv.stop();
    }
  });

  test("under GRAYBOARD_TEST_BACKEND=pg, describeSqlite and testSqlite skip, named as SQLite only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-sqlite-only-"));
    try {
      const file = join(dir, "fixture.test.ts");
      writeFileSync(file, `
import { expect, test } from "bun:test";
import { describeSqlite, testSqlite, TEST_BACKEND } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
test("runs", () => { console.log("BACKEND " + TEST_BACKEND); });
describeSqlite("second connection", () => { test("inner", () => { console.log("RAN inner"); }); });
testSqlite("file only", () => { console.log("RAN file only"); });
`);
      const run = async (backend: string) => {
        const child = Bun.spawn([process.execPath, "test", file], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, GRAYBOARD_TEST_BACKEND: backend } });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { text: out + err, code };
      };
      const pg = await run("pg");
      expect(pg.code).toBe(0);
      expect(pg.text).toContain("BACKEND pg");
      expect(pg.text).not.toContain("RAN ");
      expect(pg.text).toContain("skip (SQLite only): second connection");
      expect(pg.text).toContain("skip (SQLite only): file only");
      expect(pg.text).toMatch(/2 skip/);
      const sqlite = await run("sqlite");
      expect(sqlite.code).toBe(0);
      expect(sqlite.text).toContain("RAN inner");
      expect(sqlite.text).toContain("RAN file only");
      expect(sqlite.text).not.toContain("SQLite only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // main.ts end to end: the URL behind the gate opens (and migrates) the Postgres Repo, and the startup line names the
  // host and database, never the credentials.
  test("ServerProcess on a url: main.ts serves Postgres, logs no credentials, and refuses the url without the gate", async () => {
    await using db = await pgDatabase({ max: 1 });
    const main = [process.execPath, join(ROOT, "src/server/main.ts")];
    const srv = await ServerProcess.start(main, { url: db.url });
    try {
      expect(await srv.login("alice@example.com")).toBeString();
      const [row] = await db.sql`SELECT email FROM users`;
      expect(row).toEqual({ email: "alice@example.com" });
    } finally {
      await srv.stop();
    }
    const u = new URL(db.url);
    expect(srv.log()).toContain(`store postgres ${u.host}/${db.name}`);
    expect(srv.log()).not.toContain(`${u.username}:${u.password}@`);
    await expect(ServerProcess.start(main, { url: db.url }, { GRAYBOARD_UNRELEASED_POSTGRES: "" })).rejects.toThrow("GRAYBOARD_DATABASE_URL needs GRAYBOARD_UNRELEASED_POSTGRES=1");
    // The open (and its migration) failing fails the startup before anything listens.
    const missing = await ServerProcess.start(main, { url: pgUrl(`${db.name}_missing`) }).then(() => "listened", (e: Error) => e.message);
    expect(missing).toContain(`grayboard server: startup failed: opening postgres ${u.host}/${db.name}_missing`);
    expect(missing).not.toContain(`${u.username}:${u.password}@`);
  });
});
