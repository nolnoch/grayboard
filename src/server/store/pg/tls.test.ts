// Verified TLS to Postgres (#1525). The deploy verifies the database's certificate through the URL alone
// (`?sslmode=verify-full&sslrootcert=<CA bundle>`): openPg passes the URL to Bun.SQL untouched, and Bun.SQL reads both
// parameters. Nothing in this repo parses them, so this file pins the driver's behavior against a Bun upgrade that drops
// it. No Postgres needed: a fake endpoint answers the SSLRequest with 'S' and runs the server side of the handshake, so
// "the handshake completed" is the accept signal and a client-side certificate error is the refuse signal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { waitForPg } from "./connect.ts";
import { openPg } from "./sql.ts";

const dir = mkdtempSync(join(tmpdir(), "grayboard-pg-tls-"));
const SSL_REQUEST = 80877103;

function openssl(args: string[]): void {
  const p = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`openssl ${args.join(" ")}: ${p.stderr.toString()}`);
}

// Two CAs; the server's certificate is signed by `right` and names only `localhost`, so connecting to 127.0.0.1 is a
// hostname mismatch with a trusted chain.
function makeCerts(): void {
  for (const ca of ["right", "wrong"]) {
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `ca-${ca}.key`, "-out", `ca-${ca}.pem`, "-days", "2", "-subj", `/CN=gb-test-ca-${ca}`]);
  }
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "san.ext"), "subjectAltName=DNS:localhost\n");
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca-right.pem", "-CAkey", "ca-right.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "san.ext"]);
}

// A backend ErrorResponse: 'E', int32 length (itself included), then severity, SQLSTATE and message fields, ending in 0.
function errorResponse(sqlstate: string, message: string): Buffer {
  const body = Buffer.concat([Buffer.from(`SFATAL\0C${sqlstate}\0M${message}\0`), Buffer.from([0])]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

let server: net.Server;
const sockets = new Set<net.Socket>();
let port = 0;
// Server-side handshakes completed, per connection attempt.
let handshakes = 0;

beforeAll(async () => {
  makeCerts();
  const key = await Bun.file(join(dir, "server.key")).text();
  const cert = await Bun.file(join(dir, "server.crt")).text();
  server = net.createServer(sock => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      sock.off("data", onData);
      if (buf.readInt32BE(4) !== SSL_REQUEST) { sock.destroy(); return; }
      sock.write("S");
      const secure = new tls.TLSSocket(sock, { isServer: true, key, cert });
      secure.on("error", () => {});
      // Past the handshake, refuse the login with a protocol ErrorResponse so the client fails at once; a bare close
      // would leave it waiting out its connection timeout.
      secure.on("secure", () => { handshakes++; secure.end(errorResponse("28000", "tls test: handshake accepted")); });
    };
    sock.on("data", onData);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  // A refused handshake leaves its socket to the client, so close() alone would wait on them.
  for (const s of sockets) s.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const ACCEPTED = { handshake: true, code: "ERR_POSTGRES_SERVER_ERROR" };
const url = (host: string, query: string) => `postgres://u:p@${host}:${port}/d?${query}`;
const verifyFull = (host: string, ca: string) => url(host, `sslmode=verify-full&sslrootcert=${join(dir, ca)}`);

// One connection attempt through openPg, with startup params as the transaction store sets them (store/pg/tx.ts).
// Resolves to whether the server's handshake completed and the client's error code. The fake refuses every login, so an
// accepted connection ends in the server error it read over TLS (ACCEPTED), a refused one in a certificate error.
async function attempt(u: string): Promise<{ handshake: boolean; code: string }> {
  const before = handshakes;
  const sql = openPg(u, { max: 1, connectionTimeout: 5, applicationName: "tls-test", connection: { lock_timeout: 1000 } });
  let code = "";
  try {
    await sql`select 1`;
  } catch (e) {
    code = String((e as { code?: unknown }).code ?? "");
  } finally {
    await sql.close().catch(() => {});
  }
  return { handshake: handshakes > before, code };
}

describe("Postgres TLS through the URL (#1525)", () => {
  test("verify-full with the right CA completes the handshake", async () => {
    expect(await attempt(verifyFull("localhost", "ca-right.pem"))).toEqual(ACCEPTED);
  });

  test("verify-full with a CA bundle holding the right CA completes the handshake", async () => {
    writeFileSync(join(dir, "bundle.pem"), (await Bun.file(join(dir, "ca-wrong.pem")).text()) + (await Bun.file(join(dir, "ca-right.pem")).text()));
    expect(await attempt(verifyFull("localhost", "bundle.pem"))).toEqual(ACCEPTED);
  });

  test("verify-full refuses a server certificate from another CA", async () => {
    expect(await attempt(verifyFull("localhost", "ca-wrong.pem"))).toEqual({ handshake: false, code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  });

  test("verify-full refuses a trusted certificate that doesn't name the host", async () => {
    expect(await attempt(verifyFull("127.0.0.1", "ca-right.pem"))).toEqual({ handshake: false, code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  test("verify-full refuses a missing CA file", async () => {
    const r = await attempt(verifyFull("localhost", "missing.pem"));
    expect(r.handshake).toBe(false);
    expect(r.code).toBe("ERR_INVALID_ARG_TYPE");
  });

  test("verify-full with no CA file refuses a certificate outside the system store", async () => {
    expect(await attempt(url("localhost", "sslmode=verify-full"))).toEqual({ handshake: false, code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  });

  // The docs warn that require doesn't verify: this is that claim.
  test("require with no CA file encrypts without verifying", async () => {
    expect(await attempt(url("localhost", "sslmode=require"))).toEqual(ACCEPTED);
  });

  test("a certificate refusal fails the startup wait at once instead of retrying", async () => {
    let sleeps = 0;
    const wait = waitForPg(verifyFull("localhost", "ca-wrong.pem"), { seconds: 30, log: () => {}, sleep: async () => { sleeps++; } });
    await expect(wait).rejects.toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(sleeps).toBe(0);
  });
});
