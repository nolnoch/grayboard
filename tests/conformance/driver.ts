// The conformance suite's drivers (#926): one MCP tool surface, driven black-box in each mode. A scenario sees
// only Peer.call and the Outcome it returns, so a driver for the compiled server or a client SDK can run the same
// scenario files later. Nothing here imports src/.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { freePort } from "../support/hosted_oauth.ts";
import { closeSessions, localSession } from "../support/mcp.ts";
import { ServerProcess, TestServer } from "../support/server.ts";

export type Mode = "local" | "hosted";

// A tool call's result: the parsed JSON (or text) of a success, or a refusal with the code the mode reported,
// if it reports one. Message text is never compared: two cores may word a refusal differently.
// `data` is the rest of a refusal's structuredContent (`known`, `holder`…), normalized like a success's value.
export type Outcome = { ok: true; value: any } | { ok: false; code?: string; data?: Record<string, any>; text: string };

export type Peer = { readonly name: string; call(tool: string, args?: Record<string, unknown>): Promise<Outcome> };

// One isolated bus per scenario; peers on it are sessions of one user, named by bare handle.
export type Bus = { peer(name: string): Promise<Peer>; close(): Promise<void> };

// `mode` decides which mode-tagged scenarios run; `label` names the driver in test names and skip lines, so two
// drivers of one mode (`hosted`, `hosted/rust`) are told apart.
export type Driver = { readonly mode: Mode; readonly label: string; bus(): Promise<Bus>; stop(): Promise<void> };

function outcome(r: { content: unknown; isError?: unknown; structuredContent?: unknown }, strip: (s: string) => string): Outcome {
  const text = (r.content as { type: string; text?: string }[]).find(c => c.type === "text")?.text ?? "";
  if (r.isError) {
    const { code, ...rest } = (r.structuredContent ?? {}) as Record<string, unknown>;
    const data = Object.keys(rest).length ? { data: normalize(rest, strip) as Record<string, any> } : {};
    return { ok: false, text, ...(typeof code === "string" ? { code } : {}), ...data };
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = text; }
  return { ok: true, value: normalize(value, strip) };
}

// Every string in a result, with the mode's handle qualification removed, so `be` reads the same in both modes.
function normalize(v: unknown, strip: (s: string) => string): unknown {
  if (typeof v === "string") return strip(v);
  if (Array.isArray(v)) return v.map(x => normalize(x, strip));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, strip)]));
  return v;
}

// Local: each peer is a `grayboard mcp --mode local` child bound to its name, on a fresh bus directory.
export function localDriver(): Driver {
  return {
    mode: "local",
    label: "local",
    async bus() {
      const dir = mkdtempSync(join(tmpdir(), "gb-conformance-"));
      return {
        async peer(name) {
          const s = await localSession(dir, name);
          return { name, call: async (tool, args = {}) => outcome(await s.c.callTool({ name: tool, arguments: args }).catch((e: Error) => {
            e.message += `\n${s.stderr()}`;
            throw e;
          }) as CallToolResult, s => s) };
        },
        async close() {
          await closeSessions();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    async stop() {},
  };
}

// Hosted: each bus is its own in-process server (claims and boards are server-wide, so a fresh user alone would
// share them), and each peer a hosted MCP session of one user bound to its name. Handles come back qualified by
// the user's email (`you@example.com/be`); the driver strips that prefix.
export function hostedDriver(): Driver {
  return {
    mode: "hosted",
    label: "hosted",
    async bus() {
      const server = new TestServer({ hostedRequestLimit: { burst: 100_000, perSec: 100_000 } });
      const email = "you@example.com";
      const prefix = `${email}/`;
      const strip = (s: string) => s.split(prefix).join("");
      return {
        async peer(name) {
          const s = await server.hosted(email, name);
          return {
            name,
            async call(tool, args = {}) {
              const result = await s.callRaw(tool, args);
              // A bind or unbind closes the lease (docs/handles.md, Hosted owner); a hosted client reopens it while
              // holds remain (adapters/hosted-core/src/controller.ts). An unbind of the last hold answers name null.
              if ((tool === "bind" || tool === "unbind") && !result.isError) {
                const name = (result.structuredContent as { name?: unknown } | undefined)?.name;
                if (name !== null) await s.reopen();
              }
              return outcome(result, strip);
            },
          };
        },
        close: () => server.stop(),
      };
    },
    async stop() {},
  };
}

// The Rust SDK (#929; docs/sdk-rust.md §4): each bus is a compiled server process with a service an admin created
// through the admin routes and one credential of it, and one conformance-driver process
// (sdk/rust/conformance-driver) speaking JSON lines on stdio, whose peers are Rust sessions of that service, each
// authenticated by the SDK's ClientCredentials minting its own run token (no seeded token, so nothing here depends on
// the store's shape). It answers each call's raw CallToolResult, so outcome() reads it as it reads hostedDriver's; the
// lease rule matches hostedDriver's, in the binary. Joins DRIVERS only when GRAYBOARD_RUST_DRIVER names the built
// binary (scripts/e2e.sh rust-sdk builds it and the server).
const RUST_ADMIN = "root@example.com";
const RUST_SERVICE = "conformance";
const SERVER_BIN = join(import.meta.dir, "../../dist/grayboard-server");

function spawnDriver(bin: string) {
  return Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, RUST_BACKTRACE: "1" } });
}

export function rustDriver(bin: string): Driver {
  return {
    mode: "hosted",
    label: "hosted/rust",
    async bus() {
      if (!existsSync(bin)) throw new Error(`GRAYBOARD_RUST_DRIVER: no binary at ${bin}`);
      if (!existsSync(SERVER_BIN)) throw new Error(`the Rust driver needs the compiled server at ${SERVER_BIN}: bun run build`);
      const dir = mkdtempSync(join(tmpdir(), "gb-conformance-rust-"));
      const dbPath = join(dir, "server.db");
      const port = freePort();
      const issuer = `http://127.0.0.1:${port}`;
      const url = `${issuer}/mcp`;
      const prefix = `${RUST_SERVICE}/`;
      const strip = (s: string) => s.split(prefix).join("");
      // scenario.ts opens a bus outside its try: a failed start stops what it started and removes the dir itself.
      let credential: { client_id: string; client_secret: string }, server: ServerProcess | undefined, proc: ReturnType<typeof spawnDriver>;
      try {
        server = await ServerProcess.start(SERVER_BIN, dbPath, {
          GRAYBOARD_PUBLIC_URL: issuer,
          GRAYBOARD_HTTP_PORT: String(port),
          GRAYBOARD_ADMINS: RUST_ADMIN,
          GRAYBOARD_HOSTED_REQUEST_SERVICE_BURST: "10000", GRAYBOARD_HOSTED_REQUEST_SERVICE_PER_SEC: "10000",
          GRAYBOARD_HOSTED_SUBSCRIBER_SERVICE_BURST: "10000", GRAYBOARD_HOSTED_SUBSCRIBER_SERVICE_PER_SEC: "10000",
          GRAYBOARD_HELLO_SERVICE_BURST: "10000", GRAYBOARD_HELLO_SERVICE_PER_SEC: "10000",
        });
        const admin = await server.login(RUST_ADMIN);
        const post = async (path: string, body: unknown) => {
          const r = await fetch(`${server!.base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: JSON.stringify(body) });
          const text = await r.text();
          if (r.status !== 201) throw new Error(`${path} answered ${r.status}: ${text}`);
          return JSON.parse(text);
        };
        await post("/api/admin/services", { name: RUST_SERVICE, owners: [RUST_ADMIN] });
        credential = await post("/api/admin/services/credentials", { service: RUST_SERVICE });
        proc = spawnDriver(bin);
      } catch (e) {
        await server?.stop();
        rmSync(dir, { recursive: true, force: true });
        throw e;
      }
      const running = server;
      let stderr = "";
      const drainErr = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true });
      })();
      // Answers by id: requests may be pipelined, and the driver answers in completion order.
      const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
      let next = 0;
      const failAll = (why: string) => {
        for (const p of pending.values()) p.reject(new Error(`${why}\n${stderr}\n${running.log()}`));
        pending.clear();
      };
      const reader = (async () => {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout) {
          buf += decoder.decode(chunk, { stream: true });
          for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line) as { id: number | null; result?: unknown; error?: string };
            const p = msg.id === null ? undefined : pending.get(msg.id);
            if (!p) {
              failAll(`conformance-driver answered an unknown id: ${line}`);
              continue;
            }
            pending.delete(msg.id!);
            if (msg.error !== undefined) p.reject(new Error(`conformance-driver: ${msg.error}\n${stderr}`));
            else p.resolve(msg.result);
          }
        }
        failAll("conformance-driver exited");
      })();
      const send = (req: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ id, ...req }) + "\n");
        proc.stdin.flush();
      });
      let session = 0;
      return {
        async peer(name) {
          await send({ op: "peer", peer: name, url, issuer, client_id: credential.client_id, secret: credential.client_secret, session: `rust-conformance-${++session}` });
          return { name, call: async (tool, args = {}) => outcome(await send({ op: "call", peer: name, tool, args }), strip) };
        },
        async close() {
          try {
            proc.stdin.write(JSON.stringify({ op: "close" }) + "\n");
            proc.stdin.end();
            const killer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
            const code = await proc.exited;
            clearTimeout(killer);
            await Promise.all([reader, drainErr]);
            if (code !== 0) throw new Error(`conformance-driver exited ${code}\n${stderr}`);
          } finally {
            await running.stop();
            rmSync(dir, { recursive: true, force: true });
          }
        },
      };
    },
    async stop() {},
  };
}

const rustBin = process.env.GRAYBOARD_RUST_DRIVER;
if (!rustBin) console.log("conformance: hosted/rust skipped (set GRAYBOARD_RUST_DRIVER to the built conformance-driver, or run scripts/e2e.sh rust-sdk)");
export const DRIVERS: (() => Driver)[] = [localDriver, hostedDriver, ...(rustBin ? [() => rustDriver(rustBin)] : [])];
