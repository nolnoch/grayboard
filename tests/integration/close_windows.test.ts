// #807 P3 B1c's ordering fixes (#1205): each store call in a bind, an unbind or the Slack bridge's attach yields, so
// a close or a stale link can land between the body's last write and the step that makes it live. Each test holds a
// body inside that window, closes (or unlinks) meanwhile, and asserts the body refuses and rolls back.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { idAddress } from "../../src/core/bindings.ts";
import { TestServer } from "../support/server.ts";
import { until } from "../support/until.ts";
import { drained, rows as sqlRows } from "../support/repo_sql.ts";

const A = "alice@example.com";
let srv: TestServer;
beforeEach(async () => {
  srv = await TestServer.open({ hostedRequestLimit: { burst: 10_000, perSec: 10_000 } });
});
afterEach(async () => {
  await srv.stop();
});

async function rows<T>(sql: string, ...args: (string | number)[]): Promise<T[]> {
  await drained(srv);
  return sqlRows<T>(srv, sql, ...args);
}

// Holds the next call of `obj[name]` whose arguments match `when` until released; the rest pass through.
function holdNext<O extends object, K extends keyof O>(obj: O, name: K, when: (...args: any[]) => boolean) {
  const original = obj[name] as unknown as (...args: any[]) => Promise<unknown>;
  let entered = false, armed = true;
  let release!: () => void;
  const released = new Promise<void>(r => { release = r; });
  (obj as any)[name] = async (...args: any[]) => {
    if (armed && when(...args)) {
      armed = false;
      entered = true;
      await released;
    }
    return original.apply(obj, args);
  };
  return {
    entered: () => until(() => entered),
    release,
    restore: () => { (obj as any)[name] = original; release(); },
  };
}

const refusedWith = (p: Promise<unknown>) => p.then(() => "(resolved)", (e: Error) => e.message);

test("a bind whose session closes after its last write refuses and rolls back: no hold for a closed session", async () => {
  const s = await srv.connected(await srv.login(A), "first");
  const id = idAddress(s.key);
  // bindNow's last await before it registers the holds (setHolds) is holdsOf.
  const hold = holdNext(srv.app.repo.bindings, "holdsOf", (_h: unknown, who: string) => who === id);
  try {
    const bound = refusedWith(s.bind("second", { create: true }));
    await hold.entered();
    s.close();
    hold.release();
    expect(await bound).toContain("closed");
  } finally { hold.restore(); }
  expect(await rows(`SELECT address FROM alias_holds WHERE id = ? ORDER BY address`, id)).toEqual([{ address: `${A}/first` }]);
  expect(await rows(`SELECT event FROM binding_events WHERE name = ?`, `${A}/second`)).toEqual([]);
});

test("an unbind whose session closes after its last write refuses and rolls back: the hold stays", async () => {
  const s = await srv.connected(await srv.login(A), "first");
  const id = idAddress(s.key);
  await s.bind("second", { create: true });
  // unbind's last await before it drops the hold from the live session (setHolds) is the claims read.
  const hold = holdNext(srv.app.repo.claims, "list", () => true);
  try {
    const unbound = refusedWith(s.unbind("second"));
    await hold.entered();
    s.close();
    hold.release();
    expect(await unbound).toContain("closed");
  } finally { hold.restore(); }
  expect(await rows(`SELECT address FROM alias_holds WHERE id = ? ORDER BY address`, id)).toEqual([{ address: `${A}/first` }, { address: `${A}/second` }]);
  expect(await rows(`SELECT event FROM binding_events WHERE name = ? AND event = 'released'`, `${A}/second`)).toEqual([]);
});

test("an attach whose link goes stale while its rows are written refuses: the recheck comes after the last write", async () => {
  await srv.login(A);
  const user = (await srv.app.repo.users.findByEmail(srv.app.repo.read, A))!;
  const human = `${A}/human`;
  const sink = { deliver() {}, closed() {} };
  let stale = false;
  // attachHuman writes the alias's touch and its bound row, then rechecks the link (`late`): a stale link that lands
  // during those writes is seen. Rechecked before them, it would commit a human for a link that's gone.
  const hold = holdNext(srv.app.repo.bindings, "touchAlias", (_tx: unknown, address: string) => address === human);
  try {
    const attached = refusedWith(srv.app.application.attachHuman({ user_id: user.id, user_email: A, kind: "user", session_id: 0 }, sink, () => (stale ? "the Slack link changed" : null)));
    await hold.entered();
    stale = true;
    hold.release();
    expect(await attached).toBe("the Slack link changed");
  } finally { hold.restore(); }
  expect(await rows(`SELECT event FROM binding_events WHERE name = ?`, human)).toEqual([]);
});
