import { expect, test } from "bun:test";
import { createCimdResolver, parseCimd, publicAddress } from "./oauth-cimd.ts";
import { matchesRedirect } from "./oauth-config.ts";

const id = "https://opencode.ai/oauth/opencode/client.json";
const document = (clientId = id) => JSON.stringify({ client_id: clientId, client_name: "OpenCode", redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
test("CIMD accepts only public unicast DNS answers, including no mapped/tunnel aliases", () => {
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(publicAddress(address)).toBe(true);
  for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:db8::1", "2002:0808:0808::", "2001::1", "3fff::1", "not-an-ip"]) expect(publicAddress(address)).toBe(false);
});
test("CIMD validates exact self identity, public authentication, registered redirects and grants", () => {
  const client = parseCimd(id, document());
  expect(client.scopes).toEqual(["grayboard:delivery", "grayboard:tools"]);
  expect(client.allowRefresh).toBe(true);
  for (const uri of ["http://127.0.0.1:54321/callback", "http://localhost:54321/callback"]) expect(matchesRedirect(client, uri)).toBe(true);
  for (const uri of ["http://127.0.0.2:54321/callback", "http://localhost:54321/other", "https://localhost/callback"]) expect(matchesRedirect(client, uri)).toBe(false);
  for (const value of [document("https://other.example/client.json"), document().replace('"none"', '"client_secret_basic"'), document().replace("http://localhost/callback", "http://private.example/callback"), document().replace('"code"]', '"token"]'), "x".repeat(32769)]) expect(() => parseCimd(id, value)).toThrow();
});
test("CIMD pins the validated DNS address to transport, coalesces requests and bounds positive/negative caching", async () => {
  let now = 0, dns = 0, reads = 0;
  const resolver = createCimdResolver({ now: () => now, resolve: async host => { expect(host).toBe("opencode.ai"); dns++; return [{ address: "93.184.216.34", family: 4 }]; }, read: async (url, address, signal) => { reads++; expect(url.href).toBe(id); expect(address).toEqual({ address: "93.184.216.34", family: 4 }); expect(signal.aborted).toBe(false); return document(); } });
  try {
    const clients = await Promise.all(Array.from({ length: 16 }, () => resolver.resolve(id)));
    expect(clients.every(c => c?.clientId === id)).toBe(true);
    expect(dns).toBe(1); expect(reads).toBe(1);
    await resolver.resolve(id); expect(dns).toBe(1);
    now = 300001; await resolver.resolve(id); expect(dns).toBe(2);
    for (const bad of ["http://opencode.ai/client.json", "https://127.0.0.1/client.json", "https://[::1]/client.json", "https://opencode.ai:8443/client.json", "https://user@opencode.ai/client.json", "https://opencode.ai/client.json#fragment", "https://opencode.ai/client.json?query"]) expect(await resolver.resolve(bad)).toBeUndefined();
    expect(dns).toBe(2);
  } finally { resolver.close(); }
});
test("CIMD bounds parallel metadata work and aborts outstanding connections on close", async () => {
  let reads = 0, aborted = 0;
  let started!: () => void;
  const allStarted = new Promise<void>(resolve => { started = resolve; });
  const resolver = createCimdResolver({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], read: async (_url, _address, signal) => new Promise<string>((_resolve, reject) => {
    reads++;
    signal.addEventListener("abort", () => { aborted++; reject(new Error("closed")); }, { once: true });
    if (reads === 8) started();
  }) });
  const pending = Array.from({ length: 8 }, (_, i) => resolver.resolve(`https://client-${i}.example/client.json`));
  await allStarted;
  expect(await resolver.resolve("https://overflow.example/client.json")).toBeUndefined();
  expect(reads).toBe(8);
  resolver.close();
  expect(await Promise.all(pending)).toEqual(Array(8).fill(undefined));
  expect(aborted).toBe(8);
  expect(await resolver.resolve(id)).toBeUndefined();
});

test("CIMD metadata deadline includes a stalled DNS lookup", async () => {
  const resolver = createCimdResolver({ resolve: () => new Promise(() => {}) });
  try { expect(await resolver.resolve(id)).toBeUndefined(); } finally { resolver.close(); }
}, 7000);

test("a mixed public/private DNS answer is refused before any connection and failures are negatively cached", async () => {
  let now = 0, reads = 0, dns = 0;
  const resolver = createCimdResolver({ now: () => now, resolve: async () => { dns++; return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]; }, read: async () => { reads++; return document(); } });
  try {
    expect(await resolver.resolve(id)).toBeUndefined(); expect(reads).toBe(0);
    expect(await resolver.resolve(id)).toBeUndefined(); expect(dns).toBe(1);
    now = 30001; expect(await resolver.resolve(id)).toBeUndefined(); expect(dns).toBe(2);
  } finally { resolver.close(); }
});
