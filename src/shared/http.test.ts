import { afterAll, expect, test } from "bun:test";

import { HTTP_TIMEOUT_MS, describeFetchError, transferTimeoutMs } from "./http.ts";

// Answers /headers never, and /body with headers and then a body that stalls.
const stalled = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/headers") return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])) }));
  },
});
afterAll(() => stalled.stop(true));

test("a deadline missed before the answer or while reading it is named as one", async () => {
  const atFetch = await fetch(`http://localhost:${stalled.port}/headers`, { signal: AbortSignal.timeout(50) }).catch((e) => e);
  expect(describeFetchError(atFetch, 50)).toBe("no answer within 0s");
  const res = await fetch(`http://localhost:${stalled.port}/body`, { signal: AbortSignal.timeout(50) });
  const atBody = await res.arrayBuffer().catch((e) => e);
  expect(describeFetchError(atBody, 30_000)).toBe("no answer within 30s");
  expect(describeFetchError(new Error("connection refused"), 50)).toBe("connection refused");
});

test("a file's deadline grows with its size", () => {
  expect(transferTimeoutMs(0)).toBe(HTTP_TIMEOUT_MS);
  expect(transferTimeoutMs(25 * 1024 * 1024)).toBe(HTTP_TIMEOUT_MS + 204_800);
});
