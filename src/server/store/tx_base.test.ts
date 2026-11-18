// The savepoint template in tx_base.ts against a fake backend whose frames settle synchronously (SQLite's shape) or
// after a deferred promise (Postgres's RELEASE / ROLLBACK TO round trip), #807 P3 C2a. The contract suite runs only
// SQLite's synchronous frames, so the async half and the `settled` hook are pinned here.
import { describe, expect, test } from "bun:test";
import { BaseTx, type SavepointFrame, type Tx } from "./tx_base.ts";

type Gate = { promise: Promise<void>; open(): void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(r => { open = r; });
  return { promise, open };
}

class FakeTx extends BaseTx {
  constructor(readonly name: string, readonly log: string[], readonly frames: "sync" | "async", root?: BaseTx,
    readonly gates: Gate[] = []) { super(true, root); }
  #n = 0;
  protected openSavepoint(root: BaseTx): { frame: SavepointFrame; tx: BaseTx } {
    const name = `${this.name}.sp${++this.#n}`;
    const { log, gates } = this;
    log.push(`SAVEPOINT ${name}`);
    const settle = (verb: string) => {
      log.push(`${verb} ${name} sent`);
      if (this.frames === "sync") { log.push(`${verb} ${name} done`); return; }
      const g = gate();
      gates.push(g);
      return g.promise.then(() => { log.push(`${verb} ${name} done`); });
    };
    return {
      frame: { commit: () => settle("RELEASE"), rollback: () => settle("ROLLBACK TO") },
      tx: new FakeTx(name, log, this.frames, root, gates),
    };
  }
  protected deferEffect(): void {}
  protected override settled(inner: BaseTx, kept: boolean): void { this.log.push(`settled ${(inner as FakeTx).name} ${kept}`); }
  put(v: string): void { this.assertLive(); this.log.push(`put ${v} on ${this.name}`); }
}

const fake = (tx: Tx) => tx as unknown as FakeTx;
const refusal = (f: () => void): string => { try { f(); return "accepted"; } catch (e) { return (e as Error).message; } };
// Lets queued microtasks and the gate's continuation run.
const flush = () => new Promise<void>(r => setTimeout(r, 0));
const opens = (g: Gate[]) => (g.at(-1) ?? (() => { throw new Error("no frame is waiting on a gate"); })()).open();

describe("tx_base savepoint template", () => {
  test("async RELEASE: the inner Tx refuses once its body fulfils, the parent until the frame settles", async () => {
    const log: string[] = [];
    const root = new FakeTx("root", log, "async");
    let inner!: FakeTx;
    const done = root.savepoint(async tx => { inner = fake(tx); inner.put("a"); });
    await flush();
    expect(log).toEqual(["SAVEPOINT root.sp1", "put a on root.sp1", "RELEASE root.sp1 sent"]);
    // A task the body started and didn't await, firing while RELEASE is in flight.
    expect(refusal(() => inner.put("stray"))).toContain("Tx used after its transaction settled");
    expect(refusal(() => inner.beforeCommit({}, async () => {}))).toContain("Tx used after its transaction settled");
    expect(await inner.savepoint(async () => {}).then(() => "accepted", e => e.message)).toContain("Tx used after its transaction settled");
    expect(refusal(() => root.put("stray"))).toContain("Tx used while its savepoint is open");
    expect(await root.savepoint(async () => {}).then(() => "accepted", e => e.message)).toContain("Tx used while its savepoint is open");
    // `settled` waits for the RELEASE: a backend moves the savepoint's effects only once it succeeded.
    expect(log.some(l => l.startsWith("settled"))).toBe(false);
    opens(root.gates);
    await done;
    expect(log.slice(3)).toEqual(["RELEASE root.sp1 done", "settled root.sp1 true"]);
    root.put("after");
    expect(log.at(-1)).toBe("put after on root");
  });

  test("async ROLLBACK TO: the parent stays blocked until the frame settles, and settled(false) follows it", async () => {
    const log: string[] = [];
    const root = new FakeTx("root", log, "async");
    let inner!: FakeTx;
    const done = root.savepoint(async tx => { inner = fake(tx); inner.put("a"); throw new Error("body failed"); });
    const outcome = done.then(() => "fulfilled", e => e.message);
    await flush();
    expect(log.at(-1)).toBe("ROLLBACK TO root.sp1 sent");
    expect(refusal(() => inner.put("stray"))).toContain("Tx used after its transaction settled");
    // A stray parent SAVEPOINT here would nest inside the frame being rolled back (and RELEASE with it, 3B001 later).
    expect(refusal(() => root.put("stray"))).toContain("Tx used while its savepoint is open");
    expect(await root.savepoint(async () => {}).then(() => "accepted", e => e.message)).toContain("Tx used while its savepoint is open");
    expect(log.some(l => l.startsWith("settled"))).toBe(false);
    opens(root.gates);
    expect(await outcome).toBe("body failed");
    expect(log.slice(-2)).toEqual(["ROLLBACK TO root.sp1 done", "settled root.sp1 false"]);
    root.put("after");
    expect(log.at(-1)).toBe("put after on root");
  });

  test("a failed async RELEASE settles the savepoint as rolled back and rejects with its error", async () => {
    const log: string[] = [];
    class FailingRelease extends FakeTx {
      protected override openSavepoint(root: BaseTx) {
        const { tx } = super.openSavepoint(root);
        return { frame: { commit: () => Promise.reject(new Error("RELEASE failed")), rollback: () => {} }, tx };
      }
    }
    const root = new FailingRelease("root", log, "async");
    const key = {};
    const outcome = await root.savepoint(async tx => { tx.beforeCommit(key, async () => {}); }).then(() => "fulfilled", e => e.message);
    expect(outcome).toBe("RELEASE failed");
    expect(log.at(-1)).toBe("settled root.sp1 false");
    expect(root.hasBeforeCommit).toBe(false);
    root.put("after");
  });

  test("runBeforeCommit: an open savepoint's keys drop and its Tx closes before the hooks run; the root stays blocked", async () => {
    const log: string[] = [];
    const root = new FakeTx("root", log, "async");
    const seen: string[] = [];
    const resume = gate();
    let inner!: FakeTx, nested!: FakeTx;
    // A body that started these and didn't await them (D4); the inner one's key was registered outside it first.
    const shared = {};
    root.beforeCommit(shared, async () => { seen.push("root"); });
    const stray = root.savepoint(async tx => {
      inner = fake(tx);
      inner.beforeCommit({}, async () => { seen.push("stray"); });
      inner.beforeCommit(shared, async () => { seen.push("stray shared"); });
      void inner.savepoint(async t => { nested = fake(t); nested.beforeCommit({}, async () => { seen.push("nested"); }); await resume.promise; }).catch(() => {});
      await resume.promise;
    }).catch(e => (e as Error).message);
    await root.runBeforeCommit();
    expect(seen).toEqual(["root"]);
    expect(refusal(() => inner.beforeCommit({}, async () => {}))).toContain("Tx used after its transaction settled");
    expect(refusal(() => nested.put("late"))).toContain("Tx used after its transaction settled");
    expect(refusal(() => root.put("hook"))).toContain("Tx used while its savepoint is open");
    expect(root.hasBeforeCommit).toBe(false);
    // The transaction ends; the strays' frames never settle here (their gates stay shut), as nothing awaits them.
    root.close();
    void stray;
  });

  test("a synchronous frame settles in the same turn as the body's result: no extra await", async () => {
    const log: string[] = [];
    const root = new FakeTx("root", log, "sync");
    // The body queues a marker two microtasks deep. Its resolved result resumes the template one microtask after the
    // body returns, between those two: a synchronous RELEASE and `settled` land there, before the marker. An
    // unconditional `await` of the frame's result would push them behind it.
    await root.savepoint(async tx => {
      fake(tx).put("a");
      queueMicrotask(() => queueMicrotask(() => log.push("marker")));
    });
    expect(log).toEqual(["SAVEPOINT root.sp1", "put a on root.sp1", "RELEASE root.sp1 sent", "RELEASE root.sp1 done",
      "settled root.sp1 true", "marker"]);
  });
});
