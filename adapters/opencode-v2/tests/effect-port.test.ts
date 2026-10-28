import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ownedScope } from "./effect-host.js";
import { barrier, bounded } from "./reload-state.js";

test("fixture scope remains live until close and joins held cleanup exactly once", async () => {
  const scope = await ownedScope(), entered = barrier(), released = barrier();
  let calls = 0, closed = false;
  await scope.run(Effect.addFinalizer(() => Effect.promise(async () => { calls++; entered.release(); await released.promise; })));
  const close = scope.close().then(() => { closed = true; });
  try {
    await bounded(entered.promise, 1000, "Owned fixture finalizer entered");
    expect(closed).toBe(false); expect(calls).toBe(1);
    released.release(); await close; await scope.close(); expect(closed).toBe(true); expect(calls).toBe(1);
  } finally { released.release(); await scope.close(); }
});

test("close and recreate own independent fixture lifetimes", async () => {
  const first = await ownedScope(), second = await ownedScope();
  const finalized: string[] = [];
  try {
    await first.run(Effect.addFinalizer(() => Effect.sync(() => { finalized.push("first"); })));
    await second.run(Effect.addFinalizer(() => Effect.sync(() => { finalized.push("second"); })));
    await first.close(); expect(finalized).toEqual(["first"]);
    expect(await second.run(Effect.succeed("live"))).toBe("live");
    await second.close(); expect(finalized).toEqual(["first", "second"]);
  } finally { await first.close(); await second.close(); }
});
