import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Binding } from "../src/binding.js";

function fixture() {
  let config: { type: string; url: string; headers: Record<string, string>; oauth: { client_id: string; scope: string; auth_server_metadata_url?: string } } = { type: "remote", url: "https://grayboard.example.com/mcp", headers: { "X-Grayboard-Identity": "be" } as Record<string, string>, oauth: { client_id: "native", scope: "grayboard:tools grayboard:delivery", auth_server_metadata_url: "https://grayboard.example.com/.well-known/oauth-authorization-server" } };
  let id = "credential-one", status: string | undefined, access = "fake-access-one", expires = Date.now() + 60_000, resolutions = 0, disposals = 0, drifts = 0;
  let integrationID = "native-integration", activeCalls = 0, listCalls = 0;
  let afterResolve = () => {}, beforeActive = (_call: number) => {}, beforeList = (_call: number) => {};
  const ctx = {
    mcp: {
      transform: async (callback: (editor: { get(name: string): unknown }) => void) => { callback({ get: () => config }); return { dispose: async () => { disposals++; } }; },
      list: async () => { beforeList(++listCalls); return { data: [{ name: "grayboard", integrationID }] }; },
    },
    integration: {
      get: async () => ({ data: { connections: [{ type: "credential", id, status }] } }),
      connection: {
        active: async () => { beforeActive(++activeCalls); return { type: "credential", id }; },
        resolve: async () => {
          resolutions++; afterResolve();
          return { type: "oauth", access, expires, get refresh(): never { throw new Error("Refresh must never be read"); } };
        },
      },
    },
  } as unknown as Context;
  const binding = new Binding(ctx, "grayboard", () => { drifts++; });
  return { binding, get config() { return config; }, set config(value) { config = value; }, get resolutions() { return resolutions; }, get disposals() { return disposals; }, get drifts() { return drifts; }, get activeCalls() { return activeCalls; }, get listCalls() { return listCalls; }, beforeActive: (callback: (call: number) => void) => { beforeActive = callback; }, beforeList: (callback: (call: number) => void) => { beforeList = callback; }, integration: (value: string) => { integrationID = value; }, select: (value: string) => { id = value; }, status: (value?: string) => { status = value; }, access: (value: string) => { access = value; }, expire: () => { expires = 0; }, afterResolve: (callback: () => void) => { afterResolve = callback; } };
}

test("binding refuses every selected configuration change before credential resolution", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.config.url = "https://other.example.com/mcp"; },
    (f: ReturnType<typeof fixture>) => { f.config.headers["X-Grayboard-Identity"] = "fe"; },
    (f: ReturnType<typeof fixture>) => { f.config.oauth.client_id = "other"; },
    (f: ReturnType<typeof fixture>) => { f.config.oauth.scope += " extra"; },
    (f: ReturnType<typeof fixture>) => { f.config.oauth.auth_server_metadata_url = "https://other.example.com/discovery"; },
    (f: ReturnType<typeof fixture>) => { f.select("credential-two"); },
  ];
  for (const mutate of mutations) {
    const f = fixture(), enrolled = await f.binding.capture(); mutate(f);
    await expect(f.binding.access(enrolled)).rejects.toThrow();
    expect(f.resolutions).toBe(0); expect(f.drifts).toBe(1); expect(f.disposals).toBe(2);
  }
});

test("old/old/other/old selection is latched before resolving the other credential", async () => {
  for (const status of [undefined, "needs_auth"]) {
    const f = fixture();
    f.beforeActive(call => { f.select(call === 3 ? "credential-other" : "credential-one"); f.status(call === 3 ? status : undefined); });
    const expected = await f.binding.capture();
    await expect(f.binding.access(expected)).rejects.toThrow("Native endpoint, identity or account changed");
    expect(f.activeCalls).toBe(3); expect(f.resolutions).toBe(0); expect(f.drifts).toBe(1);
  }
});

test("intermediate integration and configuration mismatches latch before resolution", async () => {
  const f = fixture();
  f.beforeList(call => { f.integration(call === 3 ? "other-integration" : "native-integration"); });
  const expected = await f.binding.capture();
  await expect(f.binding.access(expected)).rejects.toThrow("Native endpoint, identity or account changed");
  expect(f.listCalls).toBe(3); expect(f.resolutions).toBe(0); expect(f.drifts).toBe(1);
  const g = fixture();
  g.beforeActive(call => { g.config.headers["X-Grayboard-Identity"] = call === 3 ? "fe" : "be"; });
  const configured = await g.binding.capture();
  await expect(g.binding.access(configured)).rejects.toThrow("Native endpoint, identity or account changed");
  expect(g.activeCalls).toBe(3); expect(g.resolutions).toBe(0); expect(g.drifts).toBe(1);
});

test("embedded discovery defaults use only canonical root or prefixed MCP paths", async () => {
  for (const prefix of ["", "/hosted", "/nested/hosted"]) {
    const f = fixture(); delete f.config.oauth.auth_server_metadata_url;
    f.config.url = "https://grayboard.example.com" + prefix + "/mcp";
    expect((await f.binding.configuration()).discovery).toBe("https://grayboard.example.com/.well-known/oauth-authorization-server" + prefix);
  }
  for (const path of ["/", "/other", "/mcp/", "/hosted//mcp", "/hosted/../mcp", "/hosted/%2e/mcp", "/hosted%2fmcp/mcp", "/hosted\\\\prefix/mcp", "/mcp?query=1", "/mcp#fragment"]) {
    const f = fixture(); delete f.config.oauth.auth_server_metadata_url;
    f.config.url = "https://grayboard.example.com" + path;
    await expect(f.binding.configuration()).rejects.toThrow(); expect(f.resolutions).toBe(0);
  }
  for (const url of ["http://grayboard.example.com/mcp", "https://user@grayboard.example.com/mcp"]) {
    const f = fixture(); delete f.config.oauth.auth_server_metadata_url; f.config.url = url;
    await expect(f.binding.configuration()).rejects.toThrow();
  }
});

test("explicit metadata override stays selected and default discovery is not an issuer guess", async () => {
  const f = fixture(); f.config.url = "https://grayboard.example.com:443/hosted/mcp";
  f.config.oauth.auth_server_metadata_url = "https://auth.example.com/discovery";
  expect((await f.binding.configuration()).discovery).toBe("https://auth.example.com/discovery");
  delete f.config.oauth.auth_server_metadata_url;
  const configured = await f.binding.configuration();
  expect(configured.url).toBe("https://grayboard.example.com/hosted/mcp");
  expect(configured.discovery).toBe("https://grayboard.example.com/.well-known/oauth-authorization-server/hosted");
});

test("value-only native access rotation is allowed without reading refresh", async () => {
  const f = fixture(), enrolled = await f.binding.capture();
  expect(await f.binding.access(enrolled)).toBe("fake-access-one");
  f.access("fake-access-two");
  expect(await f.binding.access(enrolled)).toBe("fake-access-two");
  expect(f.drifts).toBe(0);
});

test("binding rechecks after async resolution and refuses status and expiry", async () => {
  const f = fixture(), enrolled = await f.binding.capture();
  f.afterResolve(() => { f.config.headers["X-Grayboard-Identity"] = "fe"; });
  await expect(f.binding.access(enrolled)).rejects.toThrow(); expect(f.resolutions).toBe(1);
  const g = fixture(), selected = await g.binding.capture(); g.status("needs_auth");
  await expect(g.binding.access(selected)).rejects.toThrow(); expect(g.resolutions).toBe(0);
  const h = fixture(), expected = await h.binding.capture(); h.expire();
  await expect(h.binding.access(expected)).rejects.toThrow();
});

test("native static authority headers are not inherited by subscriber", async () => {
  for (const name of ["Authorization", "X-Grayboard-Lease", "X-Grayboard-Client"]) {
    const f = fixture(); f.config.headers[name] = "forbidden";
    await expect(f.binding.capture()).rejects.toThrow(); expect(f.resolutions).toBe(0);
  }
});
