import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Binding } from "../src/binding.js";

export function fixture() {
  const config: { type: "remote"; url: string; headers: Record<string, string>; oauth?: false | { client_id?: string; scope?: string } } = { type: "remote", url: "https://grayboard.example.com/mcp", headers: {} };
  let id = "credential-one", access = "fake-access-one", expires = Date.now() + 60_000, resolutions = 0, drifts = 0;
  let status: string | undefined;
  const metadata = { serverUrl: config.url, issuer: "https://grayboard.example.com", scope: "grayboard:tools grayboard:delivery", client: { client_id: "https://opencode.ai/oauth/opencode/client.json", get client_secret(): never { throw new Error("Client secret must never be read"); } } };
  let afterResolve = () => {};
  const observers = new Set<(editor: { get(name: string): unknown }) => void>();
  const reload = () => { for (const observer of observers) observer({ get: () => config }); };
  const ctx = {
    mcp: {
      transform: async (callback: (editor: { get(name: string): unknown }) => void) => { observers.add(callback); callback({ get: () => config }); return { dispose: async () => { observers.delete(callback); } }; },
      list: async () => ({ data: [{ name: "grayboard", integrationID: "native-integration" }] }),
    },
    integration: {
      get: async () => ({ data: { connections: [{ type: "credential", id, status }] } }),
      connection: {
        active: async () => ({ type: "credential", id }),
        resolve: async () => { resolutions++; afterResolve(); return { type: "oauth", access, expires, metadata, get refresh(): never { throw new Error("Refresh must never be read"); } }; },
      },
    },
  } as unknown as Context;
  const binding = new Binding(ctx, "grayboard", () => { drifts++; });
  return { ctx, binding, config, metadata, reload, get resolutions() { return resolutions; }, get drifts() { return drifts; }, select: (value: string) => { id = value; }, status: (value?: string) => { status = value; }, access: (value: string) => { access = value; }, expire: () => { expires = 0; }, afterResolve: (callback: () => void) => { afterResolve = callback; } };
}
test("native discovery needs no explicit OAuth block or fixed name; exact grant is projected", async () => {
  const f = fixture(), e = await f.binding.capture();
  expect(e.configuration).toMatchObject({ issuer: f.metadata.issuer, clientID: f.metadata.client.client_id, scope: "grayboard:delivery grayboard:tools" });
  expect(e.configuration).not.toHaveProperty("identity");
  expect(e.configuration).not.toHaveProperty("discovery");
  expect(await f.binding.access(e)).toBe("fake-access-one");
  f.access("fake-access-two"); expect(await f.binding.access(e)).toBe("fake-access-two");
  expect(f.drifts).toBe(0);
});
test("endpoint, account, and exact native grant changes latch without retarget", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.config.url = "https://other.example.com/mcp"; },
    (f: ReturnType<typeof fixture>) => { f.select("other"); },
    (f: ReturnType<typeof fixture>) => { f.metadata.issuer += "/other"; },
    (f: ReturnType<typeof fixture>) => { f.metadata.client.client_id = "other"; },
    (f: ReturnType<typeof fixture>) => { f.metadata.scope += " extra"; },
    (f: ReturnType<typeof fixture>) => { f.config.oauth = { client_id: "override" }; },
  ]) {
    const f = fixture(), e = await f.binding.capture(); mutate(f);
    await expect(f.binding.access(e)).rejects.toThrow("changed"); expect(f.drifts).toBe(1);
  }
});
test("post-resolution away-and-back selection is fenced", async () => {
  const f = fixture(), e = await f.binding.capture();
  f.afterResolve(() => f.select("other"));
  await expect(f.binding.access(e)).rejects.toThrow("changed"); expect(f.drifts).toBe(1);
});
test("native expiry and status refuse; no refresh or private secret is read", async () => {
  const f = fixture(), e = await f.binding.capture(); f.expire();
  await expect(f.binding.access(e)).rejects.toThrow("expired");
  const g = fixture(), expected = await g.binding.capture(); g.status("needs_auth");
  await expect(g.binding.access(expected)).rejects.toThrow("authentication");
});
test("static authority headers and disabled OAuth never become subscriber authority", async () => {
  for (const key of ["Authorization", "X-Grayboard-Identity", "X-Grayboard-Lease", "X-Grayboard-Client"]) {
    const f = fixture(); f.config.headers[key] = "forbidden";
    await expect(f.binding.capture()).rejects.toThrow(); expect(f.resolutions).toBe(0);
  }
  const f = fixture(); f.config.oauth = false;
  await expect(f.binding.capture()).rejects.toThrow(); expect(f.resolutions).toBe(0);
});
test("watch rechecks later synchronous editor changes and fences disposed observers", async () => {
  const f = fixture(), e = await f.binding.capture();
  const watch = await f.binding.watch(e);
  f.reload();
  f.config.headers["X-Later-Transform"] = "away";
  await Promise.resolve();
  expect(f.drifts).toBeGreaterThan(0);
  const g = fixture(), saved = await g.binding.capture();
  const disposed = await g.binding.watch(saved);
  g.reload();
  const disposing = disposed.dispose();
  g.config.url = "https://other.example.com/mcp";
  await disposing; await Promise.resolve();
  expect(g.drifts).toBe(0);
  await watch.dispose();
});
test("incomplete public OAuth metadata fails closed rather than inventing client or scopes", async () => {
  for (const key of ["issuer", "scope", "client", "serverUrl"] as const) {
    const f = fixture(); delete (f.metadata as Partial<typeof f.metadata>)[key];
    await expect(f.binding.capture()).rejects.toThrow("projection lacks");
  }
});
