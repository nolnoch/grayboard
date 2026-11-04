// #226 §7's hosted races forced against the real pinned OpenCode host (#383). The server runs as its own
// process (real-server.ts), so a pause inside one of its transactions holds that server only; the OpenCode
// host, an out-of-band MCP client on the plugin's own grant (as real-races.ts's rebind) and a second writer
// process (tests/support/hosted-operation.ts, the way an out-of-process admin revoke writes) make the
// overlapping call. Every outcome is read from the server's database: hosted rows, holds, cursors, the
// access_log audit rows and the binding_events `released` reasons.
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { FixtureHost } from "./effect-host.js";
import type { NativeInput } from "./effect-instrument.js";
import type { RealServer } from "./real-server.ts";
import { bounded } from "./reload-state.ts";
import { assertWrote, audits, hostedRow, releases } from "./server-db.ts";
import { OPENCODE_CLIENT, OPENCODE_SESSION_META } from "../../../src/server/oauth-config.ts";
import type { OAuthPrincipal } from "../../../src/server/oauth.ts";
import { transactionProcess } from "../../../tests/support/transaction-process.ts";

export const transactionScenarios = ["pending-gate", "bind-commit", "register-txn", "attach-revoke", "lease-expire"];

// A plugin request host.ts's fetch shim forwarded: its JSON-RPC method (a new connection's `server/discover`
// included; the HTTP method for one without a body), a tool call, or an inbox read with its answer.
export type SeenMethod = { method: string; subscriber: boolean };
export type SeenCall = { name: string; session: string; subscriber: boolean; args: Record<string, unknown>; cap: string | null };
// A delivery lease the plugin opened, from delivery_open's answer.
export type SeenOpen = { capability: string; ownership: number; bind_gen: number };
export type SeenRead = { uri: string; lease: string | null; text?: string };

export interface TransactionRace {
  scenario: string; boundary: "before" | "after";
  host: FixtureHost; location: { directory: string };
  server: RealServer; db: Database; dbPath: string; blobDir: string; pauses: string; resource: string;
  calls: SeenCall[]; methods: SeenMethod[]; reads: SeenRead[]; admissions: NativeInput[]; opens: SeenOpen[];
  access(): Promise<string>;
  invoke(sessionID: string, tool: string, args: Record<string, unknown>): Promise<void>;
  enroll(sessionID: string, name: string): Promise<unknown>;
  rootState(sessionID: string): Promise<string | undefined>;
  signIn(): Promise<void>;
  outage(value: boolean): void;
}

type ToolResult = { isError?: boolean; content?: unknown };
const RACE = "you@example.com/race";

async function until(read: () => boolean | Promise<boolean>, label: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await read()) return; await Bun.sleep(50); }
  throw new Error("Transaction race wait expired: " + label);
}

// The plugin's grant, used out of band: tool calls as any session, on the same MCP endpoint and server.
async function outOfBand(f: TransactionRace) {
  const client = new Client({ name: "transaction-race", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.resource), { requestInit: { headers: { Authorization: "Bearer " + await f.access() } } }));
  const call = async (session: string, name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args, _meta: { [OPENCODE_SESSION_META]: session } }) as ToolResult;
  const ok = async (session: string, name: string, args: Record<string, unknown>) => {
    const result = await call(session, name, args);
    assert(!result.isError, `${name} as ${session} succeeds: ${JSON.stringify(result.content)}`);
    return result;
  };
  return { call, ok, close: () => client.close() };
}

export async function transactionRace(f: TransactionRace) {
  const { db, host, location, server, scenario } = f;
  const row = (raw: string) => hostedRow(db, raw);
  const cursor = (address: string) => db.query<{ last_seen_id: number }, [string, string]>("SELECT last_seen_id FROM mailbox_cursors WHERE address = ? AND stream_type = 'direct' AND stream_ref = ?").get(address, address)?.last_seen_id ?? 0;
  const message = (body: string) => db.query<{ id: number; recipient: string }, [string]>("SELECT id, recipient FROM messages WHERE body = ?").get(body);
  const auditOf = (action: string, session: string, test: (detail: Record<string, unknown>) => boolean = () => true) => audits(db, action).filter(r => r.target === session && test(r.detail));
  const create = async (title: string, parentID?: string) => {
    const s = await host.session.create({ location, title, permissions: [{ action: "*", resource: "*", effect: "allow" }], ...(parentID ? { parentID } : {}) });
    await host.session.switchModel({ sessionID: s.id, model: { providerID: "fixture", id: "fixture" } }); return s.id;
  };
  const root = await create("Transaction race root");
  await f.enroll(root, "race"); await until(() => row(root)?.lease_deadline != null, "approved root's lease");
  const oob = await outOfBand(f);
  const sender = "transaction-race-sender";
  await oob.ok(sender, "bind", { name: "sender", create: true });
  try {
    switch (scenario) {
      case "pending-gate": {
        // A pending held at hosted:pending:in-gate makes the bind wait (§7 delivery-safe rebind): the bind
        // reaches the root's gate while the read is in flight, commits nothing until the read answers, and the
        // read answers its batch under the lease it started with.
        const before = row(root)!;
        const held = await server.pause("hosted:pending:in-gate");
        await oob.ok(sender, "dm_send", { to: "race", body: "Transaction race pending" });
        await held.hit();
        const paused = f.reads.findLast(r => r.uri === "grayboard://inbox"); assert(paused && paused.text === undefined, "The held pending is the plugin's in-flight inbox read");
        const waiting = await server.trace("bindgate:bind:drain");
        const binding = oob.ok(root, "bind", { name: "be", create: true });
        await waiting.hit();
        assert.deepEqual(row(root)!.held, ["race"], "The waiting bind holds no new name");
        assert.equal(row(root)!.bind_gen, before.bind_gen, "The waiting bind moves no bind_gen");
        assert.deepEqual(auditOf("hosted.lease_closed", before.session_id), [], "The waiting bind closes no lease");
        held.release();
        await bounded(binding, 20_000, "The bind runs once the pending answers");
        await until(() => paused.text !== undefined, "The held pending answers");
        assert(!paused.text!.includes('"isError":true') && !paused.text!.includes('"error"'), "The held pending answers its batch, not a refusal: " + paused.text);
        assert(paused.text!.includes("Transaction race pending"), "The held pending's batch carries the DM queued before it answered");
        assert.deepEqual(row(root)!.held, ["race", "be"]);
        assert.equal(row(root)!.bind_gen, before.bind_gen + 1);
        assert.equal(auditOf("hosted.lease_closed", before.session_id, d => d.reason === "rebound").length, 1, "The bind then closes the read's lease");
        console.log("REAL_TXN_PENDING_GATE_OK", JSON.stringify({ bindGen: [before.bind_gen, row(root)!.bind_gen], lease: paused.lease !== null }));
        break;
      }
      case "bind-commit": {
        // A DM sent while the binder is at hosted:bind:after-commit (§7): the new hold is published, the old
        // hold is kept (#451), so the DM is queued for the old name and reaches the root once, under the lease
        // the plugin reopens after the bind: every receipt sent since the bind began carries that lease's
        // capability, so nothing consumed it in the window under the old one.
        const before = row(root)!, mark = f.calls.length;
        const held = await server.pause("hosted:bind:after-commit");
        const binding = f.invoke(root, "bind", { name: "be", create: true });
        await held.hit();
        assert.deepEqual(row(root)!.held, ["race", "be"], "Committed: the bind's hold is published, the old one kept");
        await oob.ok(sender, "dm_send", { to: "race", body: "Transaction race after commit" });
        const dm = message("Transaction race after commit")!;
        assert.equal(dm.recipient, RACE, "Queued for the old name");
        held.release();
        await bounded(binding, 30_000, "The native bind completes");
        await until(() => cursor(RACE) === dm.id, "The DM reaches the root under the reopened lease", 30_000);
        const admitted = f.admissions.filter(a => a.sessionID === root && a.text.includes("Transaction race after commit"));
        assert(admitted.length >= 1 && admitted.every(a => a.id === admitted[0]!.id), "Admitted to the root under one stable id");
        assert.equal(row(root)!.bind_gen, before.bind_gen + 1);
        const reopened = new Set(f.opens.filter(o => o.bind_gen === before.bind_gen + 1).map(o => o.capability));
        const receipts = f.calls.slice(mark).filter(c => c.name === "delivery_receipt" && c.session === root);
        assert(receipts.length >= 1 && receipts.every(c => c.cap !== null && reopened.has(c.cap)), "Every receipt since the bind is under the reopened lease: " + JSON.stringify(receipts.map(c => c.cap)));
        console.log("REAL_TXN_BIND_COMMIT_OK", JSON.stringify({ message: dm.id, admissions: admitted.length }));
        break;
      }
      case "register-txn": {
        // A registration and the root's bind, each arriving while the other holds the root's gate (§7): the
        // second waits at the gate (the bindgate:wait trace; every hosted request first snapshots its root as a
        // gate reader, so it waits there) and both land, in that order. The first is held at its async boundary
        // just inside the gate, so the server keeps serving and only the gate can make the second wait.
        const child = await create("Transaction race child", root);
        const body = "Transaction race child write";
        let first: { hit(ms?: number): Promise<void>; release(): void }, binding: Promise<ToolResult>, childCall: Promise<void>;
        const { bind_gen: gen, ownership_id: ownership } = row(root)!;
        if (f.boundary === "before") {
          first = await server.pause("hosted:register:before-txn");
          childCall = f.invoke(child, "dm_send", { to: "sender", body });
          await first.hit();
          const waiting = await server.trace("bindgate:wait");
          let settled = false;
          binding = oob.ok(root, "bind", { name: "be", create: true });
          binding.then(() => { settled = true; }, () => { settled = true; });
          await waiting.hit();
          assert(!settled, "The root's bind is waiting at the gate");
          assert.equal(row(root)!.bind_gen, gen, "The waiting bind moves no bind_gen");
        } else {
          const mark = f.calls.length;
          first = await server.pause("hosted:owning:before-txn");
          binding = oob.ok(root, "bind", { name: "be", create: true });
          await first.hit();
          assert(!f.calls.slice(mark).some(c => c.name === "delivery_open"), "The held owning call is the root's bind, not a plugin open");
          const waiting = await server.trace("bindgate:wait");
          childCall = f.invoke(child, "dm_send", { to: "sender", body });
          // The plugin registers a new child as soon as it sees it, so the registration may already be on its
          // way when the child's call is made; either way it is sent after the held bind.
          await until(() => f.calls.slice(mark).some(c => c.name === "session_register" && c.session === root), "The child's registration is sent while the bind is held");
          await waiting.hit();
        }
        assert.equal(row(child), null, "Nothing registered while the first is held");
        first.release();
        await bounded(Promise.all([binding, childCall]), 30_000, "Both land after the release");
        const r = row(root)!, c = row(child)!;
        assert.equal(c.root_session_id, r.session_id, "The child is registered directly under the root");
        assert.deepEqual(r.held, ["race", "be"]);
        assert.deepEqual([r.ownership_id, r.bind_gen], [ownership, gen + 1], "One rebind of the same ownership; the registration was not refused by it");
        const registered = auditOf("hosted.child_registered", r.session_id, d => d.source_session_id === child), rebound = auditOf("hosted.lease_closed", r.session_id, d => d.reason === "rebound");
        assert.equal(registered.length, 1); assert.equal(rebound.length, 1);
        if (f.boundary === "before") assert(registered[0]!.id < rebound[0]!.id, "The bind committed after the registration it waited for");
        else assert(rebound[0]!.id < registered[0]!.id, "The registration committed after the bind it waited for");
        assert.equal(message(body)?.recipient, "you@example.com/sender");
        assertWrote(db, "dm_send", c, r, OPENCODE_CLIENT);
        console.log("REAL_TXN_REGISTER_OK", JSON.stringify({ boundary: f.boundary, registered: registered[0]!.id, rebound: rebound[0]!.id }));
        break;
      }
      case "attach-revoke": {
        // G1 -> G2 with the attach-versus-revoke race (§7): an owning call under G2 held at hosted:attach:in-txn
        // while G1 is revoked ends attached (one hosted.grant_attached row, nothing released); a revoke of G1
        // held at hosted:revoke:in-txn while the owning call arrives ends released (one released(revoked) per
        // name, no attachment) and the plugin's bind lands under a new G2 ownership. Never both.
        const before = row(root)!, g1 = before.grant_id;
        await f.signIn();
        await until(async () => await f.rootState(root) === "paused", "The new grant latches receiving approval");
        const refresh = db.query<{ hash: string }, [string]>("SELECT hash FROM oauth_tokens WHERE grant_id = ? AND kind = 'refresh' LIMIT 1").get(g1)!.hash;
        const user = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get("you@example.com")!.id;
        const principal: OAuthPrincipal = { authed: { user_id: user, user_email: "you@example.com", session_id: 0 }, grantId: g1, clientId: OPENCODE_CLIENT, sourceKey: OPENCODE_SESSION_META, scopes: ["tools", "delivery"], accessHash: "", accessExpiry: 0 };
        const releaseFile = join(f.pauses, "revoke-release");
        const revoker = transactionProcess("tests/support/hosted-operation.ts", [f.dbPath, f.blobDir, JSON.stringify({ principal, operation: "revoke", refreshHash: refresh, now: Date.now() })], f.boundary === "before" ? "" : "hosted:revoke:in-txn", releaseFile);
        try {
          await bounded(revoker.wait("READY"), 20_000, "Revoker ready");
          let binding: Promise<void>;
          if (f.boundary === "before") {
            const held = await server.pause("hosted:attach:in-txn");
            binding = f.invoke(root, "bind", { name: "final", create: true });
            await held.hit();
            revoker.proc.stdin.end();
            await bounded(revoker.wait("OPERATING"), 10_000, "Revoke starts while the attachment is held");
            held.release();
          } else {
            revoker.proc.stdin.end();
            await bounded(revoker.wait("test pause hit: hosted:revoke:in-txn"), 10_000, "Revoke held in its transaction");
            const mark = f.calls.length;
            binding = f.invoke(root, "bind", { name: "final", create: true });
            await until(() => f.calls.slice(mark).some(c => c.name === "bind" && c.session === root), "The G2 owning call is sent while the revoke is held");
            await Bun.write(releaseFile, "release");
          }
          assert.equal(await bounded(revoker.proc.exited, 20_000, "Revoker exits"), 0); await revoker.done;
          assert.deepEqual(JSON.parse(revoker.output().trim().split("\n").at(-1)!), { ok: true }, "The revoke commits either way");
          assert.notEqual(db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM oauth_grants WHERE id = ?").get(g1)?.revoked_at ?? null, null, "G1 is revoked");
          await bounded(binding, 30_000, "The native bind completes");
        } finally { await Bun.write(releaseFile, "release"); revoker.proc.kill(); await revoker.proc.exited; }
        const attached = auditOf("hosted.grant_attached", before.session_id);
        const revoked = releases(db).filter(r => r.session_id === before.session_id && r.reason === "revoked");
        if (f.boundary === "before") {
          const now = row(root)!;
          assert.equal(now.ownership_id, before.ownership_id, "Attached: the same ownership");
          assert.notEqual(now.grant_id, g1, "Attached to G2");
          assert.deepEqual(attached.map(({ id: _, ...r }) => r), [{ actor: "you@example.com", target: before.session_id, detail: { from: g1, to: now.grant_id, ownership: before.ownership_id, client_id: OPENCODE_CLIENT } }]);
          assert.deepEqual(revoked, [], "Revoking G1 after the attachment releases nothing");
          assert(now.held.includes("final"));
        } else {
          assert.deepEqual(attached, [], "Released first: nothing attaches");
          assert.deepEqual(revoked, [{ session_id: before.session_id, name: RACE, reason: "revoked" }], "One released(revoked) per held name");
          await until(() => { const r = row(root); return !!r && r.ownership_id !== before.ownership_id && r.held.includes("final"); }, "The plugin's bind lands under a new ownership", 30_000);
          assert.notEqual(row(root)!.grant_id, g1, "The new ownership is G2's");
        }
        console.log("REAL_TXN_ATTACH_REVOKE_OK", JSON.stringify({ boundary: f.boundary, attached: attached.length, revoked: revoked.length }));
        break;
      }
      case "lease-expire": {
        // A reopen racing the expiry sweep at hosted:lease-expire:in-txn (§7): the subscriber is cut off until
        // the lease deadline passes, its retry arrives while the sweep's transaction is held, and the outcome
        // is one released(expired) and a fresh ownership: the expired lease never comes back live.
        const before = row(root)!;
        const held = await server.pause("hosted:lease-expire:in-txn");
        f.outage(true);
        await held.hit(45_000);
        // Its retry opens a new connection, so any request it sends now reaches the held server first.
        const mark = f.methods.length;
        f.outage(false);
        await until(() => f.methods.slice(mark).some(m => m.subscriber), "The subscriber's retry is sent while the expiry is held", 30_000);
        held.release();
        await until(() => { const r = row(root); return !!r && r.ownership_id !== before.ownership_id && r.lease_deadline !== null; }, "The plugin reopens under a new ownership", 45_000);
        assert.deepEqual(releases(db).filter(r => r.session_id === before.session_id), [{ session_id: before.session_id, name: RACE, reason: "expired" }], "Exactly one released(expired)");
        const ended = db.query<{ end_reason: string | null }, [number]>("SELECT end_reason FROM hosted_ownerships WHERE id = ?").get(before.ownership_id);
        assert.equal(ended?.end_reason, "expired", "The expired ownership stays ended");
        assert.deepEqual(row(root)!.held, ["race"]);
        console.log("REAL_TXN_LEASE_EXPIRE_OK", JSON.stringify({ expired: before.ownership_id, reopened: row(root)!.ownership_id }));
        break;
      }
      default: throw new Error("Unknown transaction race " + scenario);
    }
  } finally { await oob.close(); }
}
