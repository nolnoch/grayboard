import { join } from "node:path";

// A Bun script as its own process, for races a test forces across processes. `echo`, when given, prints each
// output line as it arrives, prefixed with it and the stream (`out`/`err`), so the child's lines interleave
// in order with the test's own. The two streams are read separately, so their lines may interleave out of write order.
export function transactionProcess(script: string, args: string[], pause: string, release: string, echo?: string) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: join(import.meta.dir, "../.."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, BUS_TEST_PAUSE: pause, BUS_TEST_PAUSE_FILE: release },
  });
  let stdout = "", stderr = "";
  const waiters = new Set<() => void>();
  const pump = async (stream: ReadableStream<Uint8Array>, out: boolean) => {
    const print = (text: string) => { for (const line of text.split("\n")) if (line) console.log(`${echo} ${out ? "out" : "err"} | ${line}`); };
    const decoder = new TextDecoder();
    let partial = "";
    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });
      if (out) stdout += text; else stderr += text;
      if (echo !== undefined) { const lines = (partial + text).split("\n"); partial = lines.pop()!; print(lines.join("\n")); }
      for (const notify of waiters) notify();
    }
    if (echo !== undefined) print(partial);
  };
  const done = Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]);
  // `times`: wait for the text's nth occurrence, for a process that prints the same line more than once.
  const seen = (text: string) => (stdout + stderr).split(text).length - 1;
  const wait = (text: string, times = 1) => new Promise<void>((resolve, reject) => {
    const check = () => { if (seen(text) >= times) { waiters.delete(check); resolve(); } };
    waiters.add(check); check();
    void proc.exited.then(async () => { await done; if (seen(text) < times) reject(new Error(`worker exited before ${text}: ${stderr}`)); });
  });
  // SIGTERM, then SIGKILL if the process outlives `ms`; resolves once it exited and its output drained.
  const stop = async (ms = 5000) => {
    proc.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>(resolve => { timer = setTimeout(() => { console.log(`${echo ?? script} | no exit ${ms} ms after SIGTERM: SIGKILL`); proc.kill("SIGKILL"); resolve(); }, ms); });
    try { await Promise.race([proc.exited, late]); await proc.exited; } finally { clearTimeout(timer); }
    await done;
  };
  return { proc, wait, done, stop, output: () => stdout, errors: () => stderr };
}
