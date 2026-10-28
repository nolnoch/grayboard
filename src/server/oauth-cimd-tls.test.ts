import { expect, test } from "bun:test";
import { createServer } from "node:https";
import { connect, type TLSSocket } from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, LookupFunction } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CimdUnavailable, createCimdResolver, type CimdOptions } from "./oauth-cimd.ts";

test("hermetic CIMD resolves, validates and pins real HTTPS with isolated test trust", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-cimd-hermetic-"));
  const certificate = (name: string) => {
    const key = join(dir, `${name}.key`), cert = join(dir, `${name}.crt`);
    const result = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`, "-keyout", key, "-out", cert], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return { key: readFileSync(key), cert: readFileSync(cert) };
  };
  const valid = certificate("client.example"), wrong = certificate("wrong.example");
  const id = "https://client.example/metadata/client.json";
  const document = JSON.stringify({ client_id: id, client_name: "Hermetic client", redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none" });
  let mode = "ok", hits = 0, dns = 0, routed = 0, lookups = 0;
  const sockets = new Set<TLSSocket>();
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    hits++;
    expect(req.url).toBe("/metadata/client.json");
    expect(req.headers.host).toBe("client.example");
    expect((req.socket as TLSSocket).servername).toBe("client.example");
    expect(req.headers.accept).toBe("application/json");
    if (mode === "redirect") { res.writeHead(302, { location: "https://127.0.0.1/private" }); res.end(); return; }
    if (mode === "upstream") { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { "content-type": mode === "mime" ? "text/plain" : "application/json" });
    if (mode === "timeout") return;
    res.end(mode === "oversize" ? "x".repeat(32769) : mode === "utf8" ? Buffer.from([0xff]) : document);
  };
  const peer = createServer(valid, serve), wrongPeer = createServer(wrong, serve);
  for (const server of [peer, wrongPeer]) server.on("connection", socket => { sockets.add(socket as TLSSocket); socket.on("close", () => sockets.delete(socket as TLSSocket)); });
  const active = new Set<ReturnType<typeof createCimdResolver>>();
  const watchdog = setTimeout(() => { for (const resolver of active) resolver.close(); for (const socket of sockets) socket.destroy(); }, 12000);
  try {
    await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
    await new Promise<void>(resolve => wrongPeer.listen(0, "127.0.0.1", resolve));
    const port = (peer.address() as AddressInfo).port;
    const addresses = [{ address: "8.8.8.8", family: 4 }];
    const options: CimdOptions = {
      resolve: async host => { dns++; expect(host).toBe("client.example"); return addresses; },
      testConnect: (target, options) => {
        routed++;
        expect(target).toEqual({ hostname: "client.example", address: { address: "8.8.8.8", family: 4 } });
        expect(options.servername).toBe("client.example");
        expect(options.rejectUnauthorized).not.toBe(false);
        const pinned = options.lookup!;
        const lookup: LookupFunction = (host, args, done) => {
          expect(host).toBe("client.example");
          pinned(host, args, (error, answer, family) => {
            lookups++;
            expect(error).toBeNull();
            if (args.all) { expect(answer).toEqual(addresses); done(null, [{ address: "127.0.0.1", family: 4 }]); }
            else { expect(answer).toBe("8.8.8.8"); expect(family).toBe(4); done(null, "127.0.0.1", 4); }
          });
        };
        return connect({ ...options, port: mode === "wrong-name" ? (wrongPeer.address() as AddressInfo).port : port, ca: mode === "bad-ca" ? undefined : mode === "wrong-name" ? wrong.cert : valid.cert, rejectUnauthorized: true, lookup });
      },
    };
    for (const unsafe of [[{ address: "127.0.0.1", family: 4 }], [...addresses, { address: "10.0.0.1", family: 4 }]]) {
      const resolver = createCimdResolver({ ...options, resolve: async host => { dns++; expect(host).toBe("client.example"); return unsafe; } });
      try { expect(await resolver.resolve(id)).toBeUndefined(); expect(routed).toBe(0); expect(hits).toBe(0); }
      finally { resolver.close(); }
    }
    expect(dns).toBe(2);
    for (const scenario of ["ok", "redirect", "mime", "oversize", "utf8", "bad-ca", "wrong-name", "upstream", "timeout"]) {
      mode = scenario;
      const resolver = createCimdResolver(options); active.add(resolver);
      const before = { hits, dns, routed, lookups }, started = performance.now();
      try {
        if (["bad-ca", "wrong-name", "upstream", "timeout"].includes(scenario)) await expect(resolver.resolve(id)).rejects.toBeInstanceOf(CimdUnavailable);
        else if (scenario === "ok") {
          expect(await resolver.resolve(id)).toMatchObject({ clientId: id, name: "Hermetic client" });
          expect(await resolver.resolve(id)).toMatchObject({ clientId: id });
        } else expect(await resolver.resolve(id)).toBeUndefined();
        expect(dns - before.dns).toBe(1); expect(routed - before.routed).toBe(1); expect(lookups - before.lookups).toBe(1);
        expect(hits - before.hits).toBe(["bad-ca", "wrong-name"].includes(scenario) ? 0 : 1);
        if (scenario === "timeout") { expect(performance.now() - started).toBeGreaterThanOrEqual(4900); expect(performance.now() - started).toBeLessThan(6500); }
      } finally { resolver.close(); active.delete(resolver); }
    }
  } finally {
    clearTimeout(watchdog);
    for (const resolver of active) resolver.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => peer.close(() => resolve()));
    await new Promise<void>(resolve => wrongPeer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
