// #811: every hosted request builds its own McpServer, and the native tools' input schemas used
// to be recompiled per registration into the SDK's process-wide ajv cache, which never evicts:
// 25-47 KB of live heap retained per native call. Live heap after forced GC must stay flat.
import { afterAll, expect, test } from "bun:test";
import { TestServer } from "../support/server.ts";

const unlimited = { burst: 1e12, perSec: 1e12 };
const srv = new TestServer({ hostedRequestLimit: unlimited, helloLimit: unlimited });
afterAll(() => srv.stop());

const liveHeapMB = () => { Bun.gc(true); Bun.gc(true); return process.memoryUsage().heapUsed / 1048576; };

test("live heap stays flat across 1,000 native tool calls", async () => {
  const s = await srv.hosted("alice@example.com", "alpha");
  // Warm every lazy path (SDK, zod, statement caches) before the baseline: growth settles within
  // about 1,000 calls (+1.1, +0.2, +0.03, +0.02 MB per 1,000 after it).
  for (let i = 0; i < 1000; i++) await s.call(i % 2 ? "whoami" : "board_list");
  const before = liveHeapMB();
  for (let i = 0; i < 1000; i++) await s.call(i % 2 ? "whoami" : "board_list");
  const grew = liveHeapMB() - before;
  console.log(`live heap growth over 1,000 native calls: ${grew.toFixed(2)} MB`);
  // The leak retained ~50 MB per 1,000 calls; this bound catches one of ~2 KB per call.
  expect(grew).toBeLessThan(2);
}, 120_000);
