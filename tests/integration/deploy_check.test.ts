// scripts/deploy_check.sh against a stand-in /healthz: it passes only when the
// server answers ok with the tag's version.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanEnv } from "../support/env.ts";
import { ROOT } from "../support/paths.ts";

let health: Record<string, unknown> = { ok: true, version: "1.2.3" };
let limited = false;
const srv = Bun.serve({
  port: 0,
  fetch: (r) =>
    new URL(r.url).pathname !== "/healthz" ? new Response("no", { status: 404 })
    : limited ? Response.json({ code: "rate_limited", message: "too many authentication failures from this address; retry in 10s" }, { status: 429 })
    : Response.json(health),
});
afterAll(() => srv.stop(true));

async function check(url: string, tag: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([join(ROOT, "scripts", "deploy_check.sh"), url, tag], { env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out + err };
}

test("passes when the server reports the tag", async () => {
  health = { ok: true, version: "1.2.3" };
  expect(await check(`http://localhost:${srv.port}/`, "v1.2.3")).toMatchObject({ code: 0 });
});

test("fails on another version, on not ok, and on no answer", async () => {
  health = { ok: true, version: "1.2.2" };
  expect((await check(`http://localhost:${srv.port}`, "v1.2.3")).code).toBe(1);
  health = { ok: false, version: "1.2.3" };
  expect((await check(`http://localhost:${srv.port}`, "v1.2.3")).code).toBe(1);
  const none = await check("http://localhost:1", "v1.2.3");
  expect(none.code).toBe(1);
  expect(none.out).toContain("no healthy answer");
});

test("names the address limit when the server answers 429", async () => {
  limited = true;
  try {
    const r = await check(`http://localhost:${srv.port}`, "v1.2.3");
    expect(r.code).toBe(1);
    expect(r.out).toContain("is rate-limiting this address");
    expect(r.out).toContain("too many authentication failures from this address");
  } finally {
    limited = false;
  }
});
