// A grayboard entry command whose `mcp` answers every request with a JSON-RPC
// error and stays alive (#1142): `<bun> refusing_mcp.ts <real command…>`.
// `tools` runs the real command it wraps, so an adapter loads its tool list.
const [cmd, ...args] = process.argv.slice(2);
if (args.includes("tools")) {
  const r = Bun.spawnSync([cmd!, ...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(r.exitCode ?? 1);
}
let buf = "";
process.stdin.setEncoding("utf8").on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (typeof msg.id === "number") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "refused for test" } }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
