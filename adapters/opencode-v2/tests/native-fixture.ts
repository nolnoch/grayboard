import type { Context } from "@opencode/plugin/promise/plugin";
import { Binding } from "../src/binding.js";

// A native OpenCode MCP grant and its storage, shared by the binding and instructions tests.
export function fixture() {
  const config: { type: "remote"; url: string; headers: Record<string, string>; oauth?: false | { client_id?: string; scope?: string }; timeout?: { startup?: number; catalog?: number } } = { type: "remote", url: "https://grayboard.example.com/mcp", headers: {} };
  let id = "credential-one", access = "fake-access-one", expires = Date.now() + 60_000, resolutions = 0, drifts = 0;
  let status: string | undefined;
  const metadata = { serverUrl: config.url, issuer: "https://grayboard.example.com", scope: "grayboard:tools grayboard:delivery", client: { client_id: "https://opencode.ai/oauth/opencode/client.json", get client_secret(): never { throw new Error("Client secret must never be read"); } } };
  let afterResolve = () => {};
  const storage = new Map<string, unknown>();
  // OpenCode's MCP config: transforms read the user's `config`, and edit a copy of it (`applied`, the last result).
  type Editor = { get(name: string): unknown; update(name: string, update: (config: Record<string, unknown>) => void): void };
  const observers = new Set<(editor: Editor) => void>();
  const editor = (): Editor & { draft: typeof config } => {
    const e = { draft: config, get: () => e.draft, update: (_name: string, update: (config: Record<string, unknown>) => void) => { if (e.draft === config) e.draft = structuredClone(config); update(e.draft as Record<string, unknown>); } };
    return e;
  };
  let applied = config, reloads = 0;
  // holdReload(): the next reload waits until `release`; `reached` resolves when it starts waiting.
  let gate: (() => Promise<void>) | undefined;
  const reload = () => { const e = editor(); for (const observer of observers) observer(e); applied = e.draft; };
  const ctx = {
    mcp: {
      transform: async (callback: (editor: Editor) => void) => { observers.add(callback); callback(editor()); return { dispose: async () => { observers.delete(callback); } }; },
      list: async () => ({ data: [{ name: "grayboard", integrationID: "native-integration" }] }),
      reload: async () => { await gate?.(); reloads++; reload(); },
    },
    integration: {
      get: async () => ({ data: { connections: [{ type: "credential", id, status }] } }),
      connection: {
        active: async () => ({ type: "credential", id }),
        resolve: async () => { resolutions++; afterResolve(); return { type: "oauth", access, expires, metadata, get refresh(): never { throw new Error("Refresh must never be read"); } }; },
      },
    },
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => { storage.set(key, value); } },
  } as unknown as Context;
  const binding = new Binding(ctx, "grayboard", () => { drifts++; });
  // `rotate`: the host stores a new access token, expiring `ms` from now (OpenCode's own refresh).
  return { ctx, binding, config, metadata, reload, storage, get applied() { return applied; }, get reloads() { return reloads; }, get transforms() { return observers.size; }, get resolutions() { return resolutions; }, get drifts() { return drifts; }, select: (value: string) => { id = value; }, status: (value?: string) => { status = value; }, access: (value: string) => { access = value; }, expire: () => { expires = 0; }, rotate: (value: string, ms = 60_000) => { access = value; expires = Date.now() + ms; }, afterResolve: (callback: () => void) => { afterResolve = callback; }, holdReload: () => {
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { reached = r; });
    gate = async () => { gate = undefined; reached(); await held; };
    return { release, reached: started };
  } };
}

// Polls a condition for up to a second.
