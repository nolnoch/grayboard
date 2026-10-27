import { setTimeout as delay } from "node:timers/promises";

export async function observeEvents<T>(subscribe: () => AsyncIterable<T>, observe: (event: T) => Promise<void>, failure: (operation: "event" | "stream") => void, signal: AbortSignal, wait = async (ms: number) => { await delay(ms, undefined, { signal }); }) {
  for (let failures = 0; failures < 8 && !signal.aborted; failures++) {
    try {
      for await (const event of subscribe()) {
        if (signal.aborted) return;
        try { await observe(event); }
        catch { if (!signal.aborted) failure("event"); }
      }
    } catch { if (signal.aborted) return; }
    if (signal.aborted) return;
    failure("stream");
    if (failures === 7) return;
    try { await wait(Math.min(8000, 250 * 2 ** failures)); }
    catch { if (!signal.aborted) failure("stream"); return; }
  }
}
