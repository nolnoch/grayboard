// #807 P3 C1: the Postgres test harness itself.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { MIGRATIONS } from "../../src/server/store/pg/migrate.ts";
import { describePg, pgDatabase, pgTemplate, PG_URL, templateName } from "./pg.ts";
import { FIXTURES } from "./pg_migrate_child.ts";

test("the template's name follows every migration's version, name and text", () => {
  const base = templateName(FIXTURES);
  expect(base).toMatch(/^gb_tpl_[0-9a-f]{12}$/);
  expect(templateName(FIXTURES)).toBe(base);
  expect(templateName([FIXTURES[0]!, { ...FIXTURES[1]!, sql: FIXTURES[1]!.sql + " " }, FIXTURES[2]!])).not.toBe(base);
  expect(templateName([FIXTURES[0]!, { ...FIXTURES[1]!, name: "0002_owt" }, FIXTURES[2]!])).not.toBe(base);
  expect(templateName(FIXTURES.slice(0, 2))).not.toBe(base);
  expect(templateName(FIXTURES, "CREATE TABLE IF NOT EXISTS schema_migrations (version int8 PRIMARY KEY)")).not.toBe(base);
});

test("GRAYBOARD_TEST_PG_REQUIRED=1 without a URL fails the load instead of skipping", async () => {
  const run = async (required: string | undefined) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    delete env.GRAYBOARD_TEST_PG_URL;
    if (required === undefined) delete env.GRAYBOARD_TEST_PG_REQUIRED; else env.GRAYBOARD_TEST_PG_REQUIRED = required;
    const child = Bun.spawn([process.execPath, "-e", `await import("./tests/support/pg.ts"); console.log("loaded");`], {
      cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", env,
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out: out.trim(), code, err };
  };
  const required = await run("1");
  expect(required.code).not.toBe(0);
  expect(required.err).toContain("GRAYBOARD_TEST_PG_REQUIRED=1 but GRAYBOARD_TEST_PG_URL is unset");
  expect(await run(undefined)).toEqual({ out: "loaded", code: 0, err: "" });
});

describePg("pg.ts", () => {
  test("each test database is its own, built from a template no one can connect to, and dispose drops it", async () => {
    const { name: tpl } = await pgTemplate();
    expect(tpl).toBe(templateName(MIGRATIONS));
    const admin = new Bun.SQL(PG_URL!);
    try {
      const [t] = await admin`SELECT datistemplate, datallowconn FROM pg_database WHERE datname = ${tpl}`;
      expect(t).toEqual({ datistemplate: true, datallowconn: false });
      let gone: string;
      {
        await using a = await pgDatabase();
        await using b = await pgDatabase();
        expect(a.name).not.toBe(b.name);
        await a.sql`CREATE TABLE mine (v int4)`;
        await a.sql`INSERT INTO mine VALUES (1)`;
        expect((await b.sql`SELECT to_regclass('mine') AS r`)[0].r).toBeNull();
        // Both carry the template's schema.
        expect((await b.sql`SELECT to_regclass('schema_migrations') AS r`)[0].r).toBe("schema_migrations");
        gone = a.name;
        expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${gone}`).length).toBe(1);
      }
      expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${gone}`).length).toBe(0);
    } finally {
      await admin.close();
    }
  });

  test("a template is built once, complete, and no one can connect to it", async () => {
    // A migration set no earlier run built, so this call takes the build path.
    const fresh = [{ ...FIXTURES[0]!, sql: `${FIXTURES[0]!.sql}\n-- ${crypto.randomUUID()}` }];
    const admin = new Bun.SQL(PG_URL!);
    const name = templateName(fresh);
    try {
      const t = await pgTemplate(fresh);
      expect(t).toEqual({ name: templateName(fresh), built: true });
      expect(await pgTemplate(fresh)).toBe(t);
      const [row] = await admin`SELECT datistemplate, datallowconn FROM pg_database WHERE datname = ${t.name}`;
      expect(row).toEqual({ datistemplate: true, datallowconn: false });
      expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${t.name + "_build"}`).length).toBe(0);
    } finally {
      // The sweep drops only per-test databases: a template this test made is its to drop.
      for (const db of [name, `${name}_build`]) {
        if (!(await admin`SELECT 1 FROM pg_database WHERE datname = ${db}`).length) continue;
        await admin.unsafe(`ALTER DATABASE "${db}" WITH IS_TEMPLATE false`);
        await admin.unsafe(`DROP DATABASE "${db}" WITH (FORCE)`);
      }
      await admin.close();
    }
  });

  test("another process finds the template built rather than building it again", async () => {
    const mine = await pgTemplate();
    const child = Bun.spawn([process.execPath, "-e", `import { pgTemplate } from "./tests/support/pg.ts"; console.log(JSON.stringify(await pgTemplate())); process.exit(0);`], {
      cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", env: process.env,
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out.trim())).toEqual({ name: mine.name, built: false });
  });
});
