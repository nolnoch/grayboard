import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const main = new URL("./main.ts", import.meta.url).pathname;
const app = new URL("./app.ts", import.meta.url).pathname;
const config = new URL("./config.ts", import.meta.url).pathname;
async function shutdownCase(signal: "SIGINT" | "SIGTERM", failure?: "reject" | "throw") {
  const dir = mkdtempSync(join(tmpdir(), "gb-server-shutdown-"));
  const preload = join(dir, "preload.ts");
  writeFileSync(preload, `
import { mock } from "bun:test";
const keepAlive = setInterval(() => {}, 1000);
mock.module(${JSON.stringify(config)}, () => ({ loadConfig: () => ({}) }));
mock.module(${JSON.stringify(app)}, () => ({ startServer: () => ({
  server: { port: 0 },
  stop: ${failure === "throw" ? "" : "async"} () => {
    console.log("stop started");
    ${failure === "throw" ? 'throw new Error("private SQL /secret/blob/path");' : `
    await new Promise(resolve => process.stdin.once("data", resolve));
    console.log("cleanup completed");
    clearInterval(keepAlive);
    ${failure === "reject" ? 'throw new Error("private SQL /secret/blob/path");' : ""}
    `}
  },
}) }));
`);
  const child = spawn(process.execPath, ["--preload", preload, main], {
    cwd: dir,
    env: { HOME: dir, TMPDIR: dir, PATH: dirname(process.execPath) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", ended = false;
  child.stdout.on("data", data => { stdout += data.toString(); });
  child.stderr.on("data", data => { stderr += data.toString(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 1500;
    while (!predicate()) {
      if (ended || Date.now() >= deadline) throw new Error(`child did not reach expected stage: ${stdout} ${stderr}`);
      await Bun.sleep(5);
    }
  }
  try {
    await until(() => stdout.includes("listening on port"));
    child.kill(signal);
    await until(() => stdout.includes("stop started"));
    if (failure !== "throw") {
      child.kill("SIGINT");
      child.kill("SIGTERM");
      await Bun.sleep(40);
      expect(ended).toBe(false);
      expect(stdout.match(/stop started/g)).toHaveLength(1);
      expect(stdout).not.toContain("cleanup completed");
      child.stdin.write("finish\n");
    }
    const result = await Promise.race([exited, Bun.sleep(1500).then(() => { throw new Error("child did not exit after cleanup"); })]);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(failure ? 1 : 0);
    expect(stdout.match(/stop started/g)).toHaveLength(1);
    if (failure !== "throw") expect(stdout).toContain("cleanup completed");
    if (failure) expect(stderr).toContain("server shutdown failed");
    else expect(stderr).toBe("");
    expect(stderr).not.toContain("private SQL");
    expect(stderr).not.toContain("/secret/blob/path");
    expect(stderr).not.toContain("Unhandled");
  } finally {
    if (!ended) child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} awaits gated cleanup and ignores repeated signals`, async () => {
  await shutdownCase(signal);
});
for (const failure of ["reject", "throw"] as const) test(`shutdown ${failure} exits nonzero with a redacted diagnostic`, async () => {
  await shutdownCase("SIGTERM", failure);
});
