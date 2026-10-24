import { ApplicationError } from "./application.ts";

const MAX_BODY = 4 * 1024 * 1024;

// No Request.clone(): an unread tee can prevent cancellation of the original source.
export async function readMcpBody(request: Request, shutdown?: AbortSignal): Promise<{ parsedBody?: unknown; request: Request } | Response> {
  if (!request.body) return { request };
  const reader = request.body.getReader();
  let ended = false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancelling: Promise<void> | undefined;
  const cancel = () => cancelling ??= reader.cancel().catch(() => {});
  request.signal.addEventListener("abort", cancel, { once: true });
  shutdown?.addEventListener("abort", cancel, { once: true });
  try {
    if (Number(request.headers.get("content-length")) > MAX_BODY) return new Response("Payload Too Large", { status: 413 });
    while (!request.signal.aborted && !shutdown?.aborted) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      size += next.value.byteLength;
      if (size > MAX_BODY) return new Response("Payload Too Large", { status: 413 });
      chunks.push(next.value);
    }
    if (request.signal.aborted || shutdown?.aborted) throw new ApplicationError("unauthenticated", "request cancelled");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return { request, parsedBody: JSON.parse(new TextDecoder().decode(bytes)) }; }
    catch {
      // Let the SDK generate its own parse-error response from the bounded bytes.
      return { request: new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal: request.signal }) };
    }
  } finally {
    request.signal.removeEventListener("abort", cancel);
    shutdown?.removeEventListener("abort", cancel);
    if (!ended) await cancel();
    else if (cancelling) await cancelling;
    reader.releaseLock();
  }
}

export type OwnedStream = { stop(): Promise<void>; done: Promise<void> };

// Forward SDK bytes, owning cancellation and reader release rather than a hidden pipe promise.
export function forwardMcpStream(response: Response, signal: AbortSignal, finish: () => void): { response: Response; stream: OwnedStream } {
  const reader = response.body!.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false, finalized = false;
  let resolve!: () => void;
  let stopping: Promise<void> | undefined;
  const done = new Promise<void>(r => { resolve = r; });
  const complete = () => {
    if (finalized) return;
    finalized = true;
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch {}
    try { finish(); } catch {}
    resolve();
  };
  const stop = () => stopping ??= (async () => {
    if (stopped) return done;
    stopped = true;
    try { controller.close(); } catch {}
    try { await reader.cancel(); } catch {}
    complete();
  })();
  const abort = () => { void stop(); };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) {
          stopped = true;
          c.close();
          complete();
        } else c.enqueue(next.value);
      } catch {
        if (!stopped) { stopped = true; try { c.close(); } catch {} complete(); }
      }
    },
    cancel: () => stop(),
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), stream: { stop, done } };
}
