import { AssertionError, strict as assert } from "node:assert";
import { GrayboardClient } from "../../src/plugin/client.ts";

const original = { fetch: globalThis.fetch, timeout: AbortSignal.timeout, timer: globalThis.setTimeout, websocket: globalThis.WebSocket };

async function scenario(fault?: "immediate-retry" | "missing-abort") {
  let now = 0, fetches = 0, opened = 0, aborted = false;
  const deadlines: number[] = [], delays: number[] = [];
  const timers: { at: number; run: () => void }[] = [];
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  async function advance(target: number) {
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0]!.at > target) break;
      now = timers[0]!.at;
      timers.shift()!.run();
      await flush();
    }
    now = target;
    await flush();
  }
  AbortSignal.timeout = (ms) => {
    deadlines.push(ms);
    const controller = new AbortController();
    if (fault !== "missing-abort") timers.push({ at: now + ms, run() {
      aborted = true;
      controller.abort(new DOMException("controlled deadline", "TimeoutError"));
    } });
    return controller.signal;
  };
  globalThis.setTimeout = ((run: () => void, ms: number) => {
    delays.push(ms);
    timers.push({ at: now + (fault === "immediate-retry" ? 0 : ms), run });
    return 1;
  }) as typeof setTimeout;
  globalThis.fetch = ((_input: unknown, init: RequestInit) => {
    fetches++;
    if (fetches === 1) return new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  globalThis.WebSocket = class {
    constructor() { opened++; }
    close() {}
  } as unknown as typeof WebSocket;
  const client = new GrayboardClient("http://controlled.invalid", () => "stand-in", "fe", "stand-in", async () => {}, async () => {}, true, undefined, { probeTimeoutMs: 200 });
  try {
    client.connect();
    await flush();
    await advance(1);
    const firstArrival = now;
    await advance(199);
    assert.equal(fetches, 1);
    assert.equal(aborted, false);
    await advance(200);
    assert.equal(aborted, true, "deadline must abort the unanswered first fetch");
    await advance(1199);
    assert.equal(fetches, 1, "retry must wait for its separate backoff");
    await advance(1200);
    assert.equal(fetches, 2);
    assert.equal(opened, 1);
    assert.deepEqual(deadlines, [200, 200]);
    assert.deepEqual(delays, [1000]);
    assert.equal(now - firstArrival, 1199);
    return { deadlines, delays, fetches, arrivalGap: now - firstArrival };
  } finally {
    client.close();
    globalThis.fetch = original.fetch;
    AbortSignal.timeout = original.timeout;
    globalThis.setTimeout = original.timer;
    globalThis.WebSocket = original.websocket;
  }
}

const correct = await scenario();
const detected: string[] = [];
for (const [fault, message] of [
  ["missing-abort", "deadline must abort the unanswered first fetch"],
  ["immediate-retry", "retry must wait for its separate backoff"],
] as const) {
  try {
    await scenario(fault);
    assert.fail("negative control was not detected");
  } catch (error) {
    if (!(error instanceof AssertionError) || !error.message.includes(message)) throw error;
    detected.push(fault);
  }
}
console.log(JSON.stringify({ correct, detected }));
