import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "grayboard-cimd-tls-"));
const key = join(dir, "peer.key"), cert = join(dir, "peer.crt");
const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=client.example", "-addext", "subjectAltName=DNS:client.example", "-keyout", key, "-out", cert], { stdout: "pipe", stderr: "pipe" });
assert.equal(generated.exitCode, 0, generated.stderr.toString());
const ca = readFileSync(cert);
const original = https.request;
const id = "https://client.example/client.json";
const metadata = JSON.stringify({ client_id: id, client_name: "Transport fixture", redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none" });
let mode = "ok", family = 4, hits = 0, requests = 0, lookups = 0;
const errors: string[] = [];
const peer = https.createServer({ key: readFileSync(key), cert: ca }, (req, res) => {
  hits++;
  assert.equal(req.headers.host, `client.example:${port}`);
  assert.equal((req.socket as import("node:tls").TLSSocket).servername, "client.example");
  if (mode === "redirect") { res.writeHead(302, { location: "https://127.0.0.1/private" }); res.end(); return; }
  if (mode === "upstream") { res.writeHead(503); res.end(); return; }
  res.writeHead(200, { "content-type": "application/json" });
  if (mode === "slow") return;
  res.end(mode === "oversize" ? "x".repeat(32769) : mode === "utf8" ? Buffer.from([0xff]) : metadata);
});
await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
const port = (peer.address() as import("node:net").AddressInfo).port;
// This process alone routes the already-validated public pin to a disposable TLS peer.
mock.module("node:https", () => ({ request: (url: URL, options: https.RequestOptions, callback: (res: import("node:http").IncomingMessage) => void) => {
  requests++;
  assert.equal(url.href, id);
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, undefined);
  assert.equal(options.servername, undefined);
  const productionLookup = options.lookup!;
  const pinned = { address: family === 4 ? "8.8.8.8" : "2606:4700:4700::1111", family };
  // Assert both callback overloads without altering their production output.
  productionLookup("client.example", { all: true }, (err, addresses) => { assert.equal(err, null); assert.deepEqual(addresses, [pinned]); });
  productionLookup("client.example", { all: false }, (err, address, answerFamily) => { assert.equal(err, null); assert.equal(address, pinned.address); assert.equal(answerFamily, family); });
  const req = original(url, { ...options, port, ca: mode === "untrusted" ? undefined : ca, ...(mode === "wrong-name" ? { servername: "wrong.example" } : {}), lookup: (host, lookupOptions, done) => {
    assert.equal(host, "client.example");
    productionLookup(host, lookupOptions, (err, answer, answerFamily) => {
      lookups++;
      assert.equal(err, null);
      if (lookupOptions.all) { assert.deepEqual(answer, [pinned]); done(null, [{ address: "127.0.0.1", family: 4 }]); }
      else { assert.equal(answer, pinned.address); assert.equal(answerFamily, family); done(null, "127.0.0.1", 4); }
    });
  } }, callback);
  req.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? error.message));
  return req;
} }));
const { createCimdResolver } = await import("../../src/server/oauth-cimd.ts");
try {
  for (const scenario of ["ok4", "ok6", "redirect", "oversize", "utf8", "untrusted", "wrong-name", "upstream", "slow"]) {
    mode = scenario.startsWith("ok") ? "ok" : scenario;
    family = scenario === "ok6" ? 6 : 4;
    const beforeHits = hits, beforeRequests = requests, start = Date.now();
    const resolver = createCimdResolver({ resolve: async () => [{ address: family === 4 ? "8.8.8.8" : "2606:4700:4700::1111", family }] });
    try {
      if (["untrusted", "wrong-name", "upstream", "slow"].includes(mode)) await assert.rejects(resolver.resolve(id), /temporarily unavailable/);
      else assert.equal(!!(await resolver.resolve(id)), mode === "ok", scenario);
      assert.equal(requests - beforeRequests, 1, "redirects are never followed");
      assert.equal(hits - beforeHits, ["untrusted", "wrong-name"].includes(mode) ? 0 : 1, scenario);
      if (mode === "slow") assert.ok(Date.now() - start >= 4900 && Date.now() - start < 6500);
      console.log(`PASS ${scenario}`);
    } finally { resolver.close(); }
  }
  assert.ok(errors.includes("DEPTH_ZERO_SELF_SIGNED_CERT"), JSON.stringify(errors));
  assert.ok(errors.includes("ERR_TLS_CERT_ALTNAME_INVALID"), JSON.stringify(errors));
  assert.equal(lookups, 9);
} finally {
  peer.closeAllConnections();
  await new Promise<void>(resolve => peer.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
