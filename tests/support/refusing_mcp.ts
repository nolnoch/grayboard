// A grayboard entry command for handshake-failure tests.
//
// `<bun> refusing_mcp.ts <real command…>`: `mcp` answers every request with
// a JSON-RPC error and stays alive (#1142).
//
// `<bun> refusing_mcp.ts --session <counter file> <calls> <real
// command…>`: runs the real command and passes every line through both
// ways, except that each `grayboard/session` request whose number, counted
// across every process sharing the counter file (restarts included), is in
// <calls> (`2`, `2,4,6`, `2-5`) gets an error reply instead (#1145): 1 fails
// the start handshake, 2 the first switch's (#1148).
//
// Either way, `tools` runs the real command it wraps, so an adapter loads its
// tool list.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
// `2,4` or `2-5`: the set of call numbers.
const calls = (spec: string): Set<number> => new Set(spec.split(",").flatMap((part) => {
  const [a, b = a] = part.split("-").map(Number);
  return Array.from({ length: b! - a! + 1 }, (_, i) => a! + i);
}));
const proxy = argv[0] === "--session" ? { counter: argv[1]!, refused: calls(argv[2]!) } : undefined;
const [cmd, ...args] = proxy ? argv.slice(3) : argv;
if (args.includes("tools")) {
  const r = Bun.spawnSync([cmd!, ...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(r.exitCode ?? 1);
}
const refusal = (id: unknown) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "refused for test" } }) + "\n";

// Calls f with each complete LF-terminated line, terminator included.
function lines(f: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl + 1);
      buf = buf.slice(nl + 1);
      f(line);
    }
  };
}

if (!proxy) {
  process.stdin.setEncoding("utf8").on("data", lines((line) => {
    const msg = JSON.parse(line);
    if (typeof msg.id === "number") process.stdout.write(refusal(msg.id));
  }));
  process.stdin.on("end", () => process.exit(0));
} else {
  const real = Bun.spawn([cmd!, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  // Whole lines only, so a refusal never lands inside one of the real process's.
  const out = lines((line) => process.stdout.write(line));
  const pumped = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of real.stdout) out(decoder.decode(chunk, { stream: true }));
  })();
  // Its last lines go out before this exits with its code.
  void real.exited.then(async (code) => { await pumped.catch(() => {}); process.exit(code ?? 1); });
  process.stdin.setEncoding("utf8").on("data", lines((line) => {
    let msg: { id?: unknown; method?: unknown } = {};
    try { msg = JSON.parse(line); } catch {}
    if (msg.method === "grayboard/session") {
      const seen = (existsSync(proxy.counter) ? Number(readFileSync(proxy.counter, "utf8")) : 0) + 1;
      writeFileSync(proxy.counter, String(seen));
      if (proxy.refused.has(seen)) { process.stdout.write(refusal(msg.id)); return; }
    }
    real.stdin.write(line);
    real.stdin.flush();
  }));
  process.stdin.on("end", () => { void real.stdin.end(); });
  // Killed by the adapter: take the real process with it.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { real.kill(signal); });
}
