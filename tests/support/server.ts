// An in-process grayboard server on port 0 with dev auth. It owns a temp dir:
// its SQLite database and blobs (unless overridden) and the files of every
// session it starts live there, and stop() removes it.
//
// GRAYBOARD_TEST_BACKEND=pg (with GRAYBOARD_TEST_PG_URL) puts each server on a
// Postgres database of its own, cloned from the test template (pg.ts) and
// dropped by its final stop (#807 P3 C11b); default sqlite.
import { describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { DEFAULT_RETENTION_DAYS } from "../../src/core/boards.ts";
import { startServer, type StartOptions } from "../../src/server/app.ts";
import { openRepo } from "../../src/server/open_repo.ts";
import { DEFAULT_SERVICE_LIMITS, type Config } from "../../src/server/config.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT } from "../../src/server/rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES } from "../../src/server/client_addr.ts";
import { type AuthedUser, verifySessionToken } from "../../src/server/auth.ts";
import { attachmentDownload, attachmentRelease, attachmentUpload } from "../../src/server/http.ts";
import { UploadGate } from "../../src/server/uploads.ts";
import { cleanEnv } from "./env.ts";
import { issueOAuth } from "../helpers/oauth.ts";
import { type AppSession, type AppSessionOptions, signedIn } from "./app_session.ts";
import { HOSTED_CLIENT, HOSTED_SCOPES, HostedSession, type HostedOptions } from "./hosted_session.ts";

export const TEST_BACKEND: "sqlite" | "pg" = process.env.GRAYBOARD_TEST_BACKEND === "pg" ? "pg" : "sqlite";
if (process.env.GRAYBOARD_TEST_BACKEND && !["sqlite", "pg"].includes(process.env.GRAYBOARD_TEST_BACKEND)) {
  throw new Error(`GRAYBOARD_TEST_BACKEND is sqlite or pg, not ${process.env.GRAYBOARD_TEST_BACKEND}`);
}
if (TEST_BACKEND === "pg" && !process.env.GRAYBOARD_TEST_PG_URL) throw new Error("GRAYBOARD_TEST_BACKEND=pg needs GRAYBOARD_TEST_PG_URL");

// Tests that are SQLite by nature (a second connection to the server's file, the
// file's own behaviour, the sync_access oracle): skipped on pg, and named in the
// run's output (bun's summary counts a skip without naming it).
const sqliteOnly = (name: string) => console.log(`skip (SQLite only): ${name}`);
export const describeSqlite = (name: string, fn: () => void) => {
  if (TEST_BACKEND !== "pg") return describe(name, fn);
  sqliteOnly(name);
  return describe.skip(`${name} [SQLite only]`, fn);
};
export const testSqlite = (name: string, fn: () => unknown, timeout?: number) => {
  if (TEST_BACKEND !== "pg") return test(name, fn as () => void, timeout);
  sqliteOnly(name);
  return test.skip(`${name} [SQLite only]`, fn as () => void);
};

// A server's config overrides. `dbPath` puts it on a SQLite file there whatever the backend: a test that names the
// file reads it as SQLite (an upgrade test's release-written database).
export type TestServerOverrides = Partial<Config> & { dbPath?: string };
// `reuse`: a server stopped with stop({ keep: true }), whose database (and dir) this one takes over: a restart.
// `backend`: this server's, in place of GRAYBOARD_TEST_BACKEND's.
export type TestServerStart = StartOptions & { reuse?: TestServer; backend?: "sqlite" | "pg" };

// The database a TestServer owns: dropped (pg) with its dir on the final stop, kept by stop({ keep: true }).
// `injected`: the Repo came in through `start.repo`; `store` is then only a placeholder, so nothing may reuse it.
type Owned = { store: Config["store"]; drop(): Promise<void>; injected?: boolean };

function serverConfig(dir: string, overrides: Partial<Config>): Config {
  return {
    store: { kind: "sqlite", path: join(dir, "bus.db") },
    blobDir: join(dir, "blobs"),
    httpPort: 0,
    googleClientId: "dev",
    googleClientSecret: "",
    orgDomain: "example.com",
    publicUrl: "http://localhost",
    messageRetentionDays: DEFAULT_RETENTION_DAYS,
    auditRetentionDays: 90,
    devAuth: true,
    admins: [],
    helloLimit: DEFAULT_HELLO_LIMIT,
    authFailLimit: DEFAULT_AUTH_FAIL_LIMIT,
    trustedProxies: DEFAULT_TRUSTED_PROXIES,
    // A raised hostedRequestLimit raises the subscriber bucket too, unless the test sets that one:
    // HostedSession's inbox polling and receipts are delivery upkeep, charged there (#845).
    ...(overrides.hostedRequestLimit && !overrides.hostedSubscriberLimit ? { hostedSubscriberLimit: overrides.hostedRequestLimit } : {}),
    // And a service's tier (#270 D4), unless the test sets it: a service session polls as a user's does.
    ...(overrides.hostedRequestLimit && !overrides.serviceLimits
      ? { serviceLimits: { ...DEFAULT_SERVICE_LIMITS, hostedRequest: overrides.hostedRequestLimit, hostedSubscriber: overrides.hostedRequestLimit } } : {}),
    ...overrides,
  };
}

// A dev-auth session token for `email` on the server at `base`.
export async function devLogin(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error(`dev-login ${email}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { session_token: string }).session_token;
}

export class TestServer {
  readonly base: string;
  private appSessions: AppSession[] = [];
  private hostedSessions: HostedSession[] = [];
  private kept = false;
  // Its database and dir passed to the server that reused them: that one drops them.
  private handedOver = false;

  private constructor(readonly app: ReturnType<typeof startServer>, readonly config: Config, readonly dir: string, private readonly owned: Owned) {
    this.base = `http://localhost:${this.app.server.port}`;
  }

  // Tests skip the background timers unless they pass `background`. A Repo in `opts` is served as given (pg_server.ts).
  static async open(overrides: TestServerOverrides = {}, opts: TestServerStart = {}): Promise<TestServer> {
    const { reuse, backend = TEST_BACKEND, ...start } = opts;
    const { dbPath, ...rest } = overrides;
    if (reuse && (!reuse.kept || reuse.handedOver)) throw new Error("TestServer.open: reuse takes a server stopped with stop({ keep: true })");
    if (reuse?.owned.injected) throw new Error("TestServer.open: a server opened with an injected repo can't be reused; inject the repo again");
    if (reuse) reuse.handedOver = true;
    const dir = reuse?.dir ?? mkdtempSync(join(tmpdir(), "gb-server-"));
    let owned: Owned = reuse?.owned ?? { store: { kind: "sqlite", path: dbPath ?? join(dir, "bus.db") }, drop: async () => {}, ...(start.repo ? { injected: true } : {}) };
    let repo = start.repo;
    try {
      if (!reuse && !start.repo && !rest.store && !dbPath && backend === "pg") {
        const { pgDatabase } = await import("./pg.ts");
        const db = await pgDatabase({ max: 1 });
        owned = { store: { kind: "postgres", url: db.url }, drop: () => db[Symbol.asyncDispose]() };
      }
      const config = serverConfig(dir, { store: owned.store, ...rest });
      repo ??= config.store.kind === "postgres" ? await openRepo(config, { ...(start.now ? { now: start.now } : {}), pool: { applicationName: "gb-test", max: 4 } }) : undefined;
      try {
        return new TestServer(startServer(config, { background: false, ...start, ...(repo ? { repo } : {}) }), config, dir, owned);
      } catch (error) {
        if (repo && !start.repo) await repo.close();
        throw error;
      }
    } catch (error) {
      await owned.drop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  // The SQLite file under this server, for the tests that open it themselves (SQLite only by nature: describeSqlite).
  get dbPath(): string {
    if (this.config.store.kind !== "sqlite") throw new Error("TestServer.dbPath: this server is on Postgres; the test is SQLite only (describeSqlite)");
    return this.config.store.path;
  }

  login(email: string): Promise<string> {
    return devLogin(this.base, email);
  }

  async api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }

  // The shared attachment handlers (src/server/http.ts) run in-process as
  // `identity`, as the hosted byte routes run them once they have resolved
  // the session's bound name. For application sessions, which have no byte
  // route of their own (#475); a hosted session uses HTTP (HostedSession.upload).
  async uploadAs(token: string, identity: string, filename: string, data: Uint8Array | string): Promise<{ status: number; body: Record<string, any> }> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const url = this.handlerUrl(identity, `&filename=${encodeURIComponent(filename)}`);
    const req = new Request(url, { method: "POST", headers: { "Content-Length": String(bytes.length) }, body: bytes as Uint8Array<ArrayBuffer> });
    const total = this.app.repo.attachmentLimits.total;
    const r = await attachmentUpload(req, url, await this.authed(token), this.app.repo, new UploadGate(4 * total, total));
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  }

  async downloadAs(token: string, identity: string, id: number, guard?: () => void): Promise<{ status: number }> {
    const r = await attachmentDownload(String(id), this.handlerUrl(identity), await this.authed(token), this.app.repo, guard);
    await r.body?.cancel();
    return { status: r.status };
  }

  async releaseAs(token: string, identity: string, id: number): Promise<{ status: number }> {
    const r = await attachmentRelease(String(id), this.handlerUrl(identity), await this.authed(token), this.app.repo);
    await r.body?.cancel();
    return { status: r.status };
  }

  private async authed(token: string): Promise<AuthedUser> {
    const authed = await verifySessionToken(token, this.app.repo, this.app.touches, 0);
    if (!authed) throw new Error("the token doesn't authenticate");
    return authed;
  }

  private handlerUrl(identity: string, extra = ""): URL {
    return new URL(`${this.base}/attachments?as=${encodeURIComponent(identity)}${extra}`);
  }

  // An application-level session (no socket, no hosted store): the
  // application's own operations for one session, signed in with `token` as
  // an API request resolves it. Identity null stays unbound; connect() it.
  // Closed by stop().
  appSession(token: string, identity: string | null, opts: AppSessionOptions = {}): AppSession {
    const s = signedIn(this.app, token, identity, opts);
    this.appSessions.push(s);
    return s;
  }

  // appSession, connected (bound unless identity is null or it's tools-only).
  async connected(token: string, identity: string | null, opts: AppSessionOptions = {}): Promise<AppSession> {
    await this.app.ready;
    const s = this.appSession(token, identity, opts);
    await s.connect();
    return s;
  }

  // A hosted MCP session of `email`'s, through a built-in client's OAuth
  // grant, connected (bound and leased unless identity is null). Closed by
  // stop(). Inbox polling spends hosted requests: give this server a large
  // hostedRequestLimit (serverConfig carries it to the subscriber bucket).
  async hosted(email: string, identity: string | null, opts: HostedOptions = {}): Promise<HostedSession> {
    // The startup writes first, as the listener waits for them (#807 P3 A4): the grant is written straight to the Repo.
    await this.app.ready;
    const { token } = await issueOAuth(this.app.repo, this.app.oauth.resource, email, HOSTED_SCOPES, Date.now(), HOSTED_CLIENT);
    const s = new HostedSession(`${this.base}/mcp`, token, identity, opts);
    this.hostedSessions.push(s);
    await s.connect();
    return s;
  }

  // Every driver closes before the app stops; a hosted close that failed is
  // reported once the server is down and its dir removed. `keep` leaves the
  // database and dir for a server that reuses them (open's `reuse`).
  async stop({ keep = false }: { keep?: boolean } = {}): Promise<void> {
    for (const s of this.appSessions.splice(0)) s.close();
    const hosted = await Promise.allSettled(this.hostedSessions.splice(0).map((s) => s.close()));
    try {
      await this.app.stop();
    } finally {
      if (keep) this.kept = true;
      else if (!this.handedOver) {
        await this.owned.drop();
        rmSync(this.dir, { recursive: true, force: true });
      }
    }
    const failed = hosted.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  // Stop, keeping the database, and start again on it: a server restart.
  async restart(overrides: TestServerOverrides = {}, opts: StartOptions = {}): Promise<TestServer> {
    await this.stop({ keep: true });
    return TestServer.open(overrides, { ...opts, reuse: this, backend: this.config.store.kind === "postgres" ? "pg" : "sqlite" });
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }
}

// A grayboard server as its own process: a compiled binary (a release, or the
// build under test), or a command line (this tree's src/server/main.ts under
// bun, so a sync testPause blocks only the server). Dev auth, port 0, its DB
// at `dbPath` and its blobs beside it, or on a Postgres `url` (behind the
// unreleased gate) with `blobDir`, or a temp dir it removes on stop. Ready
// once it prints the port it listens on. Its stdout and stderr are drained
// into one log as they arrive, so it never blocks on a full pipe and log()
// mid-run has both.
export class ServerProcess {
  private constructor(
    readonly proc: Subprocess<"ignore", "pipe", "pipe">,
    readonly base: string,
    private readonly out: { text: string },
    private readonly drained: Promise<unknown>,
    private readonly ownedBlobs?: string,
  ) {}

  static async start(bin: string | string[], store: { dbPath: string } | { url: string; blobDir?: string }, extra: Record<string, string> = {}): Promise<ServerProcess> {
    const ownedBlobs = "url" in store && !store.blobDir ? mkdtempSync(join(tmpdir(), "gb-proc-blobs-")) : undefined;
    const storeEnv: Record<string, string> = "url" in store
      ? { GRAYBOARD_DATABASE_URL: store.url, GRAYBOARD_BLOB_DIR: store.blobDir ?? ownedBlobs! }
      : { GRAYBOARD_DB_PATH: store.dbPath };
    try {
      return await ServerProcess.spawn(bin, { ...storeEnv, ...extra }, ownedBlobs);
    } catch (error) {
      if (ownedBlobs) rmSync(ownedBlobs, { recursive: true, force: true });
      throw error;
    }
  }

  private static async spawn(bin: string | string[], env: Record<string, string>, ownedBlobs: string | undefined): Promise<ServerProcess> {
    const proc = Bun.spawn(Array.isArray(bin) ? bin : [bin], {
      env: cleanEnv({ GRAYBOARD_DEV_AUTH: "1", GRAYBOARD_PUBLIC_URL: "http://localhost", GRAYBOARD_HTTP_PORT: "0", ...env }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = { text: "" };
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) out.text += decoder.decode(chunk, { stream: true });
      out.text += decoder.decode();
    };
    const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, 10_000);
    const exited = proc.exited.then((code) => ({ code }));
    try {
      for (;;) {
        const port = /listening on port (\d+)\n/.exec(out.text)?.[1];
        if (port) return new ServerProcess(proc, `http://localhost:${port}`, out, drained, ownedBlobs);
        const done = await Promise.race([exited, Bun.sleep(20)]);
        if (done) {
          await drained;
          throw new Error(timedOut ? `${bin} didn't listen within 10 s; killed\n${out.text}` : `${bin} exited before listening (code ${done.code})\n${out.text}`);
        }
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  // Everything it has printed so far, stdout and stderr interleaved.
  log(): string {
    return this.out.text;
  }

  login(email: string): Promise<string> {
    return devLogin(this.base, email);
  }

  // SIGTERM runs the server's own shutdown (it doesn't close its database,
  // #168: a copy needs the -wal and -shm files beside it); SIGKILL after 5 s.
  // Resolves once it has exited and its output is all in log().
  async stop(): Promise<void> {
    this.proc.kill("SIGTERM");
    const force = setTimeout(() => this.proc.kill("SIGKILL"), 5_000);
    try {
      await this.proc.exited;
      await this.drained;
    } finally {
      clearTimeout(force);
      if (this.ownedBlobs) rmSync(this.ownedBlobs, { recursive: true, force: true });
    }
  }
}
