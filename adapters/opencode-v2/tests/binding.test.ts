import { expect, setSystemTime, test } from "bun:test";
import { fixture } from "./native-fixture.js";
import { AccessExpired, Refusal } from "../src/core/model.js";

test("native discovery needs no explicit OAuth block or fixed name; exact grant is projected", async () => {
  const f = fixture(), e = await f.binding.capture("R");
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
    const f = fixture(), e = await f.binding.capture("R"); mutate(f);
    await expect(f.binding.access(e)).rejects.toThrow("changed"); expect(f.drifts).toBe(1);
  }
});
test("post-resolution away-and-back selection is fenced", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  f.afterResolve(() => f.select("other"));
  await expect(f.binding.access(e)).rejects.toThrow("changed"); expect(f.drifts).toBe(1);
});
test("native expiry and status refuse; no refresh or private secret is read", async () => {
  const f = fixture(), e = await f.binding.capture("R"); f.expire();
  await expect(f.binding.access(e)).rejects.toThrow("Signed out of grayboard in OpenCode; reconnect or sign in using OpenCode");
  const g = fixture(), expected = await g.binding.capture("R"); g.status("needs_auth");
  await expect(g.binding.access(expected)).rejects.toThrow("authentication");
});
// #472: the server's expiry precedes OpenCode's stored one by the token
// response's latency, so a request can 401 just before the host refreshes.
test("a 401 at the token's stored expiry is the rollover, not a rejection; a token the host already replaced retries", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  const rejected = () => [...f.storage.keys()].filter(key => key.startsWith("rejectedAccess:"));
  const token = await f.binding.token(e);
  f.rotate(token, 2_000);
  const expiry = await f.binding.unauthorized(e, token).catch(error => error);
  expect(expiry).toBeInstanceOf(AccessExpired);
  expect(expiry.reason).toBe("expired");
  expect(rejected()).toEqual([]);
  expect(await f.binding.token(e)).toBe(token);
  // OpenCode stored its refresh before the 401 arrived: the SDK's retry sends the new token.
  f.rotate("fake-access-two");
  await f.binding.unauthorized(e, token);
  expect(rejected()).toEqual([]);
  expect(await f.binding.token(e)).toBe("fake-access-two");
  // A 401 for a token far from its expiry is still a rejection (#388 item 8).
  const refusal = await f.binding.unauthorized(e, "fake-access-two").catch(error => error);
  expect(refusal).toBeInstanceOf(Refusal);
  expect(refusal).not.toBeInstanceOf(AccessExpired);
  expect(rejected()).toHaveLength(1);
  await expect(f.binding.token(e)).rejects.toThrow("Native access was rejected");
});
test("static authority headers and disabled OAuth never become subscriber authority", async () => {
  for (const key of ["Authorization", "X-Grayboard-Identity", "X-Grayboard-Lease", "X-Grayboard-Client"]) {
    const f = fixture(); f.config.headers[key] = "forbidden";
    await expect(f.binding.capture("R")).rejects.toThrow(); expect(f.resolutions).toBe(0);
  }
  const f = fixture(); f.config.oauth = false;
  await expect(f.binding.capture("R")).rejects.toThrow(); expect(f.resolutions).toBe(0);
});
test("watch rechecks later synchronous editor changes and fences disposed observers", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  const watch = await f.binding.watch(e);
  f.reload();
  f.config.headers["X-Later-Transform"] = "away";
  await Promise.resolve();
  expect(f.drifts).toBeGreaterThan(0);
  const g = fixture(), saved = await g.binding.capture("R");
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
    await expect(f.binding.capture("R")).rejects.toThrow("projection lacks");
  }
});
// #661: past expiry the plugin can only make OpenCode reconnect the entry, whose first request then draws the 401
// that refreshes on 2.1.4. The reconnect flips `timeout.catalog`, outside the endpoint hash.
test("refresh reconnects once per stored expiry, flipping only timeout.catalog and restoring the user's own value", async () => {
  const f = fixture();
  f.config.timeout = { startup: 9_000, catalog: 45_000 };
  const e = await f.binding.capture("R"), watch = await f.binding.watch(e);
  try {
    // A valid token asks nothing.
    expect(await f.binding.refresh(e)).toBe(false);
    expect(f.reloads).toBe(0);
    f.expire();
    expect(await f.binding.refresh(e)).toBe(true);
    expect(f.reloads).toBe(1);
    expect(f.applied.timeout).toEqual({ startup: 9_000, catalog: 45_001 });
    // The same expiry again: no second reconnect.
    expect(await f.binding.refresh(e)).toBe(false);
    expect(f.reloads).toBe(1);
    // The next expiry flips back to exactly the user's value.
    f.rotate("fake-access-two", -1);
    expect(await f.binding.refresh(e)).toBe(true);
    expect(f.reloads).toBe(2);
    expect(f.applied.timeout).toEqual({ startup: 9_000, catalog: 45_000 });
    expect(f.config.timeout).toEqual({ startup: 9_000, catalog: 45_000 });
    // No hashed field moved: nothing drifted, and the enrollment still checks.
    expect(f.drifts).toBe(0);
    f.rotate("fake-access-three");
    await f.binding.check(e);
  } finally { await watch.dispose(); }
});
test("refresh on an entry with no timeout adds one above OpenCode's default and removes it on the next flip", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  f.expire();
  expect(await f.binding.refresh(e)).toBe(true);
  expect(f.applied.timeout).toEqual({ catalog: 30_001 });
  f.rotate("fake-access-two", -1);
  expect(await f.binding.refresh(e)).toBe(true);
  expect(f.applied).not.toHaveProperty("timeout");
  expect(f.config).not.toHaveProperty("timeout");
});
test("refresh never reconnects while a native call is in flight; a call whose after hook never came stops counting after 10 minutes", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  f.expire();
  f.binding.calling("call-1"); f.binding.calling("call-2");
  expect(await f.binding.refresh(e)).toBe(false);
  f.binding.called("call-1");
  expect(await f.binding.refresh(e)).toBe(false);
  expect(f.reloads).toBe(0);
  f.binding.called("call-2");
  expect(await f.binding.refresh(e)).toBe(true);
  expect(f.reloads).toBe(1);
  // A lost after hook.
  const g = fixture(), expected = await g.binding.capture("R");
  g.expire();
  g.binding.calling("lost");
  setSystemTime(new Date(Date.now() + 10 * 60_000 + 1));
  try { expect(await g.binding.refresh(expected)).toBe(true); }
  finally { setSystemTime(); }
});
test("a native call that starts while refresh reads the credential still holds the reconnect", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  f.expire();
  f.afterResolve(() => f.binding.calling("late"));
  expect(await f.binding.refresh(e)).toBe(false);
  expect(f.reloads).toBe(0);
});
test("refresh's transform is disposed with the binding", async () => {
  const f = fixture(), e = await f.binding.capture("R");
  const before = f.transforms;
  f.expire();
  await f.binding.refresh(e);
  expect(f.transforms).toBe(before + 1);
  await f.binding.dispose();
  expect(f.transforms).toBe(before);
});
