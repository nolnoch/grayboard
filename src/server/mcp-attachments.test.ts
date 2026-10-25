import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createOAuthServer } from "./oauth.ts";
import { createMcpAttachments } from "./mcp-attachments.ts";
import { UploadGate } from "./uploads.ts";
import { createApplication } from "./application.ts";
import { createHostedSessions, OPENCODE_CLIENT, OPENCODE_SESSION_META, sessionContext } from "./hosted.ts";

let application: ReturnType<typeof createApplication>;
let hosted: ReturnType<typeof createHostedSessions>;
import { issueOAuth } from "../../tests/helpers/oauth.ts";
import { getAttachment, bindAttachments } from "../core/attachments.ts";

let store: ReturnType<typeof openDatabase>;
let oauth: ReturnType<typeof createOAuthServer>;
let router: ReturnType<typeof createMcpAttachments>;
let gate: UploadGate;
let issued: ReturnType<typeof issueOAuth>;
let dir: string;
let now: number;
const origin = "https://grayboard.example.com";
const resource = `${origin}/hosted/mcp`;
const bytes = new TextEncoder().encode("attachment bytes\n");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(async () => {
  now = Date.now();
  dir = mkdtempSync(join(tmpdir(), "gb-oauth-attachments-"));
  store = openDatabase(join(dir, "bus.db"), { blobDir: dir });
  oauth = createOAuthServer(store.repo, { dbPath: ":memory:", blobDir: dir, httpPort: 0, googleClientId: "dev", googleClientSecret: "", orgDomain: "example.com", publicUrl: `${origin}:443/hosted`, messageRetentionDays: 90, auditRetentionDays: 90, devAuth: true, admins: [] }, { now: () => now });
  issued = issueOAuth(store.repo, resource, "alice@example.com", ["grayboard:tools"], now, OPENCODE_CLIENT);
  store.repo.identities.create(issued.authed.user_id, "be");
  gate = new UploadGate(1024, 1024);
  application = createApplication(store.repo, store.db);
  hosted = createHostedSessions(application, { now: () => now, isAuthorized: p => oauth.isAuthorized(p) });
  const principal = oauth.authenticate(new Request(resource, { headers: { Authorization: `Bearer ${issued.token}` } }), ["grayboard:tools"]);
  if (principal instanceof Response) throw new Error("fixture auth failed");
  await hosted.bind(principal, sessionContext(principal, { [OPENCODE_SESSION_META]: "attachment-root" }), { name: "be" });
  router = createMcpAttachments(store.repo, store.db, oauth, gate, { trustedOrigin: origin, sessions: hosted });
});
afterEach(async () => {
  await router.close();
  hosted.close(); application.stopExpiry(); oauth.close();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function request(method = "POST", path = "/hosted/mcp/attachments?identity=be&filename=report.txt", body: BodyInit | null = bytes, token = issued.token, extra: RequestInit = {}) {
  return new Request(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "X-Grayboard-Session": encodeURIComponent("attachment-root"), ...(method === "POST" ? { "Content-Length": String(bytes.length) } : {}) }, ...(method === "POST" ? { body } : {}), ...extra });
}
async function send(req = request()) { return (await router.fetch(req))!; }
async function uploaded() {
  const response = await send();
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}
const count = () => (store.db.query("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;

test("precise routing, canonical challenge, strict query and existing identity only", async () => {
  for (const path of ["/api/attachments", "/hosted/mcp/attachments/1/extra", "/hosted/mcp/attachments-other"]) expect(router.fetch(request("GET", path))).toBeUndefined();
  expect(router.fetch(request("PUT"))).toBeUndefined();
  for (const path of ["/mcp/attachments?identity=be&filename=report.txt", "/hosted/mcp/attachments?identity=be&filename=report.txt"]) {
    const response = await send(request("POST", path, bytes, "wrong"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('resource_metadata="https://grayboard.example.com/.well-known/oauth-protected-resource/hosted/mcp"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  }
  for (const query of ["", "identity=be", "identity=be&filename=report.txt&identity=be", "identity=human&filename=report.txt", "identity=alice%40example.com%2Fbe&filename=report.txt", "identity=be&filename=../secret", "identity=be&filename=x&access_token=bad", "identity=be&filename=x&unknown=1", "identity=be&filename=%FF", "identity=be&filename=%xx", "identity=be&filename=x%00", "identity=be&filename=x&filename=x"]) {
    expect((await send(request("POST", `/mcp/attachments?${query}`))).status).toBe(query.includes("access_token") ? 401 : query.startsWith("identity=human&") || query.startsWith("identity=alice%40") ? 403 : 400);
  }
  expect((await send(request("POST", "/mcp/attachments?identity=missing&filename=x.txt"))).status).toBe(403);
  expect(store.repo.identities.findByUserAndName(issued.authed.user_id, "missing")).toBeUndefined();
  for (const id of ["0", "-1", "1e2", "01", "9007199254740992", "%31"]) expect((await send(request("GET", `/mcp/attachments/${id}?identity=be`))).status).toBe(400);
  expect(count()).toBe(0);
});

function principal() {
  const p = oauth.authenticate(new Request(resource, { headers: { Authorization: `Bearer ${issued.token}` } }));
  if (p instanceof Response) throw new Error("fixture unauthorized");
  return p;
}

function external(operation: "bind" | "end", rawSession: string) {
  const p = principal();
  const result = Bun.spawnSync([process.execPath, "tests/support/hosted-operation.ts", join(dir, "bus.db"), dir, JSON.stringify({ now, operation, principal: p, rawSession, name: "fe" })], { stdin: Buffer.from(""), env: { ...process.env, BUS_TEST_PAUSE: "", BUS_TEST_PAUSE_FILE: "" } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!).ok).toBe(true);
}

test("all private attachment methods require mapped bound context, not a name override", async () => {
  const id = await uploaded();
  const unmapped = issueOAuth(store.repo, resource, "alice@example.com", ["grayboard:tools"], now);
  for (const method of ["POST", "GET", "DELETE"]) {
    const path = method === "POST" ? "/mcp/attachments?identity=be&filename=report.txt" : `/mcp/attachments/${id}?identity=be`;
    for (const raw of [undefined, "never-bound", "%61ttachment-root", "%FF"]) {
      const req = request(method, path);
      if (raw === undefined) req.headers.delete("X-Grayboard-Session"); else req.headers.set("X-Grayboard-Session", raw);
      expect((await send(req)).status).toBe(raw?.startsWith("%") ? 400 : 403);
    }
    expect((await send(request(method, path, bytes, unmapped.token))).status).toBe(403);
  }
  expect(count()).toBe(1);
});

test("registered child attachments resolve the root; query name is only an assertion", async () => {
  const p = principal(), root = sessionContext(p, { [OPENCODE_SESSION_META]: "attachment-root" });
  await hosted.register(p, root, "attachment-child");
  const upload = request("POST", "/mcp/attachments?filename=child.txt"); upload.headers.set("X-Grayboard-Session", "attachment-child");
  const response = await send(upload); expect(response.status).toBe(201);
  const id = (await response.json() as { id: number }).id;
  expect(getAttachment(store.db, id)?.uploader).toBe("alice@example.com/be");
  const download = request("GET", `/mcp/attachments/${id}`); download.headers.set("X-Grayboard-Session", "attachment-child");
  expect((await send(download)).status).toBe(200);
  const mismatch = request("POST", "/mcp/attachments?identity=fe&filename=child.txt"); mismatch.headers.set("X-Grayboard-Session", "attachment-child");
  expect((await send(mismatch)).status).toBe(403);
});

for (const boundary of ["body", "store", "download"] as const) for (const operation of ["bind", "end"] as const) test(`external ${operation} during attachment ${boundary} fences root and child snapshots`, async () => {
  const p = principal();
  await hosted.register(p, sessionContext(p, { [OPENCODE_SESSION_META]: "attachment-root" }), "attachment-child");
  const entered = deferred(), resume = deferred();
  let id: number | undefined, req: Request;
  if (boundary === "download") {
    id = await uploaded();
    const get = store.repo.blobs.get.bind(store.repo.blobs);
    store.repo.blobs.get = async hash => { const data = await get(hash); entered.resolve(); await resume.promise; return data; };
    req = request("GET", `/mcp/attachments/${id}`);
  } else if (boundary === "body") {
    req = request("POST", undefined, new ReadableStream({ async start(controller) { entered.resolve(); await resume.promise; controller.enqueue(bytes); controller.close(); } }));
  } else {
    const put = store.repo.blobs.put.bind(store.repo.blobs);
    store.repo.blobs.put = async (hash, data) => { entered.resolve(); await resume.promise; return put(hash, data); };
    req = request();
  }
  req.headers.set("X-Grayboard-Session", "attachment-child");
  const pending = send(req);
  await entered.promise;
  external(operation, operation === "bind" ? "attachment-root" : "attachment-child");
  resume.resolve();
  const response = await pending;
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("attachment bytes");
  expect(count()).toBe(boundary === "download" ? 1 : 0);
  const free = await gate.reserve(issued.authed.user_email, 1024, new AbortController().signal); free();
});

test("Origin precedes authentication; scope and audience never fall back", async () => {
  for (const value of ["null", "", "https://foreign.example.com", `${origin}/`, `${origin},${origin}`, "bad"]) {
    const req = request("POST", undefined, bytes, "wrong");
    req.headers.set("Origin", value);
    expect((await send(req)).status).toBe(403);
  }
  const delivery = issueOAuth(store.repo, resource, "alice@example.com", ["grayboard:delivery"], now);
  const wrongResource = issueOAuth(store.repo, `${origin}/other/mcp`, "alice@example.com", ["grayboard:tools"], now);
  for (const method of ["POST", "GET", "DELETE"]) {
    const path = method === "POST" ? "/mcp/attachments?identity=be&filename=report.txt" : "/mcp/attachments/1?identity=be";
    expect((await send(request(method, path, bytes, delivery.token))).status).toBe(403);
    expect((await send(request(method, path, bytes, wrongResource.token))).status).toBe(401);
  }
  const req = request(); req.headers.set("Origin", `${origin}:443`);
  expect((await send(req)).status).toBe(201);
});

test("stored-byte quota is shared with retained uploads and release frees it", async () => {
  store.repo.attachmentUserQuota = bytes.length;
  const id = await uploaded();
  expect((await send()).status).toBe(413);
  expect(count()).toBe(1);
  expect((await send(request("DELETE", `/mcp/attachments/${id}?identity=be`))).status).toBe(200);
  expect((await send()).status).toBe(201);
});

test("body length, MIME sniff and failure responses never leave rows", async () => {
  const noLength = request(); noLength.headers.delete("Content-Length");
  expect((await send(noLength)).status).toBe(411);
  const short = request(); short.headers.set("Content-Length", String(bytes.length + 1));
  expect((await send(short)).status).toBe(400);
  const long = request(); long.headers.set("Content-Length", "1");
  expect((await send(long)).status).toBe(400);
  const large = request(); large.headers.set("Content-Length", "999999999999");
  expect((await send(large)).status).toBe(413);
  const binary = new Uint8Array(bytes.length); binary[0] = 0x7f;
  expect((await send(request("POST", undefined, binary))).status).toBe(400);
  expect(count()).toBe(0);
});

for (const boundary of ["quota", "body", "store"] as const) for (const invalidation of ["revoke", "expire", "disable", "identity"] as const) test(`${boundary}: ${invalidation} fails closed and frees the upload`, async () => {
  const entered = deferred(), resume = deferred();
  const originalPut = store.repo.blobs.put.bind(store.repo.blobs);
  let release = () => {};
  let req = request();
  if (boundary === "quota") {
    release = await gate.reserve(issued.authed.user_email, 1024, new AbortController().signal);
  } else if (boundary === "body") {
    req = request("POST", undefined, new ReadableStream({ async start(controller) { entered.resolve(); await resume.promise; controller.enqueue(bytes); controller.close(); } }));
  } else {
    store.repo.blobs.put = async (hash, data) => { entered.resolve(); await resume.promise; return originalPut(hash, data); };
  }
  const operation = send(req);
  if (boundary === "quota") await Promise.resolve(); else await entered.promise;
  if (invalidation === "revoke") store.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, now);
  if (invalidation === "expire") now += 60 * 60 * 1000;
  if (invalidation === "disable") store.repo.users.setDisabled(issued.authed.user_id, true);
  if (invalidation === "identity") store.repo.identities.remove(issued.authed.user_id, "be");
  resume.resolve(); release();
  const response = await operation;
  expect(response.status).toBe(invalidation === "identity" ? 404 : 401);
  expect(count()).toBe(0);
  const free = await gate.reserve(issued.authed.user_email, 1024, new AbortController().signal); free();
});

test("a concurrently bound upload survives fail-closed cleanup", async () => {
  const entered = deferred(), resume = deferred();
  const original = store.repo.blobs.put.bind(store.repo.blobs);
  store.repo.blobs.put = async (hash, data) => { entered.resolve(); await resume.promise; await original(hash, data); };
  const operation = send();
  await entered.promise;
  const row = store.db.query("SELECT id FROM attachments").get() as { id: number };
  const message = store.repo.messages.insert("alice@example.com/be", "user", "alice@example.com/be", "sent", null);
  bindAttachments(store.db, [row.id], "alice@example.com/be", { message_id: message.id }, store.repo.attachmentLimits);
  store.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, now);
  resume.resolve();
  expect((await operation).status).toBe(401);
  expect(getAttachment(store.db, row.id)?.message_id).toBe(message.id);
});

for (const change of ["revoke", "expire", "disable", "identity", "retention", "fault"] as const) test(`download rechecks after blob read: ${change}`, async () => {
  const id = await uploaded();
  const entered = deferred(), resume = deferred();
  const original = store.repo.blobs.get.bind(store.repo.blobs);
  store.repo.blobs.get = async hash => { const data = await original(hash); entered.resolve(); await resume.promise; if (change === "fault") throw new Error("secret SQL /blob/path"); return data; };
  const operation = send(request("GET", `/mcp/attachments/${id}?identity=be`));
  await entered.promise;
  if (change === "revoke") store.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, now);
  if (change === "expire") now += 60 * 60 * 1000;
  if (change === "disable") store.repo.users.setDisabled(issued.authed.user_id, true);
  if (change === "identity") store.repo.identities.remove(issued.authed.user_id, "be");
  if (change === "retention") store.db.query("DELETE FROM attachments WHERE id = ?").run(id);
  resume.resolve();
  const response = await operation;
  expect(response.status).toBe(change === "fault" ? 500 : ["revoke", "expire", "disable"].includes(change) ? 401 : 404);
  const text = await response.text();
  expect(text).not.toContain("attachment bytes");
  expect(text).not.toContain("secret SQL");
  expect(text).not.toContain("/blob/path");
});

test("release rechecks authorization after the async sweep without resurrecting a deleted upload", async () => {
  const id = await uploaded();
  const entered = deferred(), resume = deferred();
  const original = store.repo.blobs.delete.bind(store.repo.blobs);
  store.repo.blobs.delete = async hash => { entered.resolve(); await resume.promise; await original(hash); };
  const releasing = send(request("DELETE", `/mcp/attachments/${id}?identity=be`));
  await entered.promise;
  store.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, now);
  resume.resolve();
  expect((await releasing).status).toBe(401);
  expect(getAttachment(store.db, id)).toBeUndefined();
});

test("revocation does not disguise a simultaneous failed blob put as authentication", async () => {
  const entered = deferred(), resume = deferred();
  store.repo.blobs.put = async () => { entered.resolve(); await resume.promise; throw new Error("secret disk failure"); };
  const storing = send(); await entered.promise;
  store.repo.oauth.revokeToken(issued.tokens.accessHash, issued.binding.clientId, now);
  resume.resolve();
  const response = await storing;
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secret disk failure");
  expect(count()).toBe(0);
});

test("pending attachment requests have a hard capacity and stop cancels their quota waits", async () => {
  const release = await gate.reserve(issued.authed.user_email, 1024, new AbortController().signal);
  const pending = Array.from({ length: 128 }, () => send());
  expect((await send()).status).toBe(503);
  await router.close(); release();
  expect((await Promise.all(pending)).every(response => response.status === 503)).toBe(true);
});

test("unexpected storage and authorization faults remain redacted 500", async () => {
  store.repo.blobs.put = async () => { throw new Error("secret disk path"); };
  const response = await send();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secret disk path");
  expect(count()).toBe(0);
  store.repo.oauth.findActiveAccess = () => { throw new Error("private SQL"); };
  expect((await send()).status).toBe(500);
});

test("shutdown cancels quota and body waiters and settles before caller closes DB", async () => {
  const release = await gate.reserve(issued.authed.user_email, 1024, new AbortController().signal);
  const pending = send();
  await router.close();
  expect((await pending).status).toBe(503);
  release();
  expect(count()).toBe(0);
  expect((await send()).status).toBe(503);
});

for (const phase of ["quota", "body"] as const) for (const action of ["abort", "close"] as const) test(`${phase}: ${action} awaits the one original source cancellation`, async () => {
  const pulled = deferred(), cancelStarted = deferred(), finishCancel = deferred();
  let pulls = 0, cancels = 0, cancelled = false, responded = false, closed = false;
  const source = new ReadableStream<Uint8Array>({
    pull() { pulls++; pulled.resolve(); },
    async cancel() { cancels++; cancelStarted.resolve(); await finishCancel.promise; cancelled = true; },
  }, { highWaterMark: 0 });
  const controller = new AbortController();
  const req = request("POST", undefined, source, issued.token, { signal: controller.signal });
  const hold = phase === "quota" ? await gate.reserve(issued.authed.user_email, 1024, new AbortController().signal) : () => {};
  const pending = send(req).then(response => { responded = true; return response; });
  let stopping = Promise.resolve();
  let capacity: Promise<() => void> | undefined;
  try {
    if (phase === "body") await pulled.promise;
    else await Bun.sleep(0);
    if (action === "close") stopping = router.close().then(() => { closed = true; });
    else controller.abort();
    await Promise.race([cancelStarted.promise, Bun.sleep(1000).then(() => { throw new Error("source cancellation never started"); })]);
    capacity = gate.reserve(issued.authed.user_email, 1024, new AbortController().signal);
    let reused = false;
    void capacity.then(() => { reused = true; });
    await Bun.sleep(0);
    expect(cancels).toBe(1);
    expect(cancelled).toBe(false);
    expect(responded).toBe(false);
    expect(closed).toBe(false);
    expect(reused).toBe(false);
    if (phase === "quota") expect(pulls).toBe(0);
    finishCancel.resolve(); hold();
    expect((await pending).status).toBe(action === "close" ? 503 : 499);
    await stopping;
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
    const finalPulls = pulls;
    await Bun.sleep(0);
    expect(pulls).toBe(finalPulls);
    expect(cancels).toBe(1);
    expect(count()).toBe(0);
  } finally {
    finishCancel.resolve(); hold();
    await pending; await stopping;
    if (capacity) (await capacity)();
  }
});

test("source cancellation failure is an internal error, not a cancellation refusal", async () => {
  const pulled = deferred(), cancelStarted = deferred(), finishCancel = deferred();
  const source = new ReadableStream<Uint8Array>({
    pull() { pulled.resolve(); },
    async cancel() { cancelStarted.resolve(); await finishCancel.promise; throw new Error("private source cleanup failure"); },
  }, { highWaterMark: 0 });
  const controller = new AbortController();
  const pending = send(request("POST", undefined, source, issued.token, { signal: controller.signal }));
  try {
    await pulled.promise; controller.abort(); await cancelStarted.promise;
    finishCancel.resolve();
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private source cleanup");
    expect(source.locked).toBe(false);
    expect(count()).toBe(0);
  } finally { finishCancel.resolve(); await pending; }
});

test("abort while reading and stop during blob put release resources", async () => {
  const controller = new AbortController();
  const req = request("POST", undefined, new ReadableStream({ start() {} }), issued.token, { signal: controller.signal });
  const pending = send(req);
  await Promise.resolve(); controller.abort();
  expect((await pending).status).toBe(499);
  const entered = deferred(), resume = deferred();
  const original = store.repo.blobs.put.bind(store.repo.blobs);
  store.repo.blobs.put = async (hash, data) => { entered.resolve(); await resume.promise; await original(hash, data); };
  const upload = send(); await entered.promise;
  let stopped = false;
  const stopping = router.close().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  resume.resolve(); await stopping;
  expect((await upload).status).toBe(503);
  expect(count()).toBe(0);
});
