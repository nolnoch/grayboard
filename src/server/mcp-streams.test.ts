import { expect, test } from "bun:test";
import { forwardMcpStream, readMcpBody } from "./mcp-streams.ts";

test("bounded request reader awaits original-source cancellation and unlocks", async () => {
  let release!: () => void, cancelStarted = false, completed = false;
  const gate = new Promise<void>(r => { release = r; });
  const body = new ReadableStream<Uint8Array>({ cancel: async () => { cancelStarted = true; await gate; } });
  const request = new Request("http://localhost/mcp", { method: "POST", headers: { "Content-Length": "4194305" }, body });
  const reading = readMcpBody(request).then(r => { completed = true; return r; });
  await Bun.sleep(0);
  expect(cancelStarted).toBe(true); expect(completed).toBe(false);
  release();
  expect((await reading as Response).status).toBe(413);
  expect(body.locked).toBe(false);
});

test("request cancellation aborts a pending bounded read without a tee", async () => {
  let cancelled = false;
  const signal = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const request = new Request("http://localhost/mcp", { method: "POST", body, signal: signal.signal });
  const reading = readMcpBody(request);
  signal.abort();
  await expect(reading).rejects.toThrow("request cancelled");
  expect(cancelled).toBe(true); expect(body.locked).toBe(false);
});

test("malformed JSON is rewound only from bounded bytes for SDK parsing", async () => {
  const request = new Request("http://localhost/mcp", { method: "POST", body: "{bad", headers: { "X-Grayboard-Identity": "be" } });
  const read = await readMcpBody(request);
  if (read instanceof Response) throw new Error("unexpected refusal");
  expect(read.parsedBody).toBeUndefined();
  expect(read.request).not.toBe(request);
  expect(await read.request.text()).toBe("{bad");
  expect(read.request.headers.get("X-Grayboard-Identity")).toBe("be");
});

for (const kind of ["consumer", "abort", "shutdown"] as const) test(`${kind}: byte forwarding owns source cancellation before cleanup`, async () => {
  let release!: () => void, cancelled = false, finished = 0;
  const gate = new Promise<void>(r => { release = r; });
  const source = new ReadableStream<Uint8Array>({ cancel: async () => { cancelled = true; await gate; } });
  const abort = new AbortController();
  const wrapped = forwardMcpStream(new Response(source, { headers: { "Content-Type": "text/event-stream" } }), abort.signal, () => { finished++; });
  const stopped = kind === "consumer" ? wrapped.response.body!.cancel() : kind === "shutdown" ? wrapped.stream.stop() : (abort.abort(), wrapped.stream.done);
  await Bun.sleep(0);
  expect(cancelled).toBe(true); expect(finished).toBe(0);
  release(); await stopped; await wrapped.stream.done;
  expect(finished).toBe(1); expect(source.locked).toBe(false);
  await wrapped.stream.stop(); expect(finished).toBe(1);
});

test("normal SDK byte completion releases reader and finishes exactly once", async () => {
  let finishes = 0;
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("SDK bytes")); c.close(); } });
  const wrapped = forwardMcpStream(new Response(source), new AbortController().signal, () => { finishes++; });
  expect(await wrapped.response.text()).toBe("SDK bytes");
  await wrapped.stream.done;
  expect(finishes).toBe(1); expect(source.locked).toBe(false);
});
