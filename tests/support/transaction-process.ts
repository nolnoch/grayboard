import { join } from "node:path";

export function transactionProcess(script: string, args: string[], pause: string, release: string) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: join(import.meta.dir, "../.."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, BUS_TEST_PAUSE: pause, BUS_TEST_PAUSE_FILE: release },
  });
  let stdout = "", stderr = "";
  const waiters = new Set<() => void>();
  const pump = async (stream: ReadableStream<Uint8Array>, out: boolean) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      if (out) stdout += decoder.decode(bytes, { stream: true }); else stderr += decoder.decode(bytes, { stream: true });
      for (const notify of waiters) notify();
    }
  };
  const done = Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]);
  const wait = (text: string) => new Promise<void>((resolve, reject) => {
    const check = () => { if ((stdout + stderr).includes(text)) { waiters.delete(check); resolve(); } };
    waiters.add(check); check();
    void proc.exited.then(async () => { await done; if (!(stdout + stderr).includes(text)) reject(new Error(`worker exited before ${text}: ${stderr}`)); });
  });
  return { proc, wait, done, output: () => stdout };
}
