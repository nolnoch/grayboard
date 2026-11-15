// The conformance suite's drivers (#926): one MCP tool surface, driven black-box in each mode. A scenario sees
// only Peer.call and the Outcome it returns, so a driver for the compiled server or a client SDK can run the same
// scenario files later. Nothing here imports src/.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeSessions, localSession } from "../support/mcp.ts";
import { TestServer } from "../support/server.ts";

export type Mode = "local" | "hosted";

// A tool call's result: the parsed JSON (or text) of a success, or a refusal with the code the mode reported,
// if it reports one. Message text is never compared: two cores may word a refusal differently.
export type Outcome = { ok: true; value: any } | { ok: false; code?: string; text: string };

export type Peer = { readonly name: string; call(tool: string, args?: Record<string, unknown>): Promise<Outcome> };

// One isolated bus per scenario; peers on it are sessions of one user, named by bare handle.
export type Bus = { peer(name: string): Promise<Peer>; close(): Promise<void> };

export type Driver = { readonly mode: Mode; bus(): Promise<Bus>; stop(): Promise<void> };

function outcome(r: { content: unknown; isError?: unknown; structuredContent?: unknown }, strip: (s: string) => string): Outcome {
  const text = (r.content as { type: string; text?: string }[]).find(c => c.type === "text")?.text ?? "";
  if (r.isError) {
    const code = (r.structuredContent as { code?: unknown } | undefined)?.code;
    return { ok: false, text, ...(typeof code === "string" ? { code } : {}) };
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

export const DRIVERS: (() => Driver)[] = [localDriver, hostedDriver];
