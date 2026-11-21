// One load-test driver process (#805): a slice of the fleet's hosted sessions, run the way
// hosted-core's controller runs one (adapters/hosted-core/src/controller.ts: a lease renewed
// every 10 s and the inbox read after it, a read on every hint, then per item a renew and its
// receipt (#845)), plus agent traffic on a wall-clock schedule. Started by scripts/loadtest.ts, which
// writes its config as one JSON line on stdin and then sends commands, one per line: "report <n>"
// (emit window n: everything since the last report, so driver and coordinator windows cover the
// same span), "churn <f>", "quiesce" (stop sending, keep draining), "close" (release every
// session, report, exit).
// Service traffic (#1258, #270 R5): a few sessions are a service's workers on its run token, the lanes of its queue
// board; every user session holds service_invoke through a team. A user's op is sometimes an invocation (a post on
// that board: service.invoke, then queueLanes to pick its lane) or a peer_list (alias.see_service per service scope);
// the lane answers each with a reply under the post, which wakes the invoker (principalCanSee on its delivery).
// A user's op is also sometimes a read of that board through the other canSee sites R5 names (#1511): board_list, a
// board_read of one of its own answered invocations' threads, the board's snapshot (resources/read) and the catalog
// (resources/list), which every session also reads once it connects, as a harness host lists resources at its start.
// Each read is checked for the service board in its result, so a read that couldn't see the board can't pass.
// Reports are JSON lines on stdout. Bun runs this on one thread, like a C program with one event
// loop: the driver's own loop lag is reported so a saturated driver's window is discarded, not
// blamed on the server.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { HostedSession, HostedToolError } from "../tests/support/hosted_session.ts";

// service: one of the service's workers (its run token, its queue board as `board`), which sends no scheduled traffic.
export type DriverSession = { index: number; email: string; token: string; name: string; address: string; board: string; service?: true };
export type DriverConfig = {
  driver: number;
  url: string;
  sessions: DriverSession[];
  // Every user session's DM address, by index (the service's workers come after them): the DM targets.
  addresses: string[];
  periodMs: number;
  postShare: number;
  // The service's queue board, and the shares of a user's ops that invoke it and that list peers; null: no service.
  svcBoard: string | null;
  svcShare: number;
  peerShare: number;
  // The share of a user's ops that read the service's board (board_list, board_read, snapshot, catalog in turn).
  readShare: number;
  burst: number;
};
// Client-side latency buckets, seconds: the server's (src/server/metrics.ts LATENCY_BUCKETS).
export const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export type Hist = { buckets: number[]; count: number; sum: number; errors: number };
export type DriverWindow = {
  type: "window"; driver: number; seq: number; at: number; live: number; inflight: number; inflightMax: number;
  lagP99: number; ops: Record<string, Hist>; errors: Record<string, number>; firstErrors: string[];
};
// misdelivered: a DM read by a session it wasn't sent to, a post by one off its board, an invocation by a session
// that isn't a lane of the service's board, or a reply by a user who didn't invoke. Invocation ids ("invoker:seq"):
// svcSent, those whose post returned; svcGot, those a lane read; svcDone, those whose reply its invoker read.
// svcPosts: the invocations' post ids, which the coordinator matches to the server's authz.decision rows.
// laneEcho: replies a lane read (it subscribes the board it answers on).
// svcReads: per read op, the calls that returned (ok), those whose result named the service's board (named), and those
// that also carried its posts (content: a board_read's thread holds the invocation and its reply; a snapshot, any post).
export type ReadProof = { ok: number; named: number; content: number };
export type DriverFinal = {
  type: "final"; driver: number; sentDm: string[]; recvDm: string[]; posts: number; boardRecv: number; misdelivered: number; misdeliveredFirst: string[];
  svcSent: string[]; svcGot: string[]; svcDone: string[]; svcPosts: number[]; laneEcho: number; svcReads: Record<string, ReadProof>; errors: Record<string, number>;
};
// The service board's reads, in the order a session takes them.
export const SVC_READS = ["board_list", "board_read", "snapshot", "catalog"] as const;
// The proofs the driver reports: the reads, and the catalog every session reads as it connects.
export const PROOF_OPS = [...SVC_READS, "catalog_connect"] as const;

const RENEW_MS = 10_000;
// Body marker: lt|<kind>|<sender index>|<seq>|<to: the target index, or the board>|<sent at ms>. An invocation (svc)
// goes to the service's board; its reply (done) carries the invocation's sender, seq and sent-at, to the invoker.
const MARK = /lt\|(dm|post|svc|done)\|(\d+)\|(\d+)\|([\w-]+)\|(\d+)/g;

const newHist = (): Hist => ({ buckets: BUCKETS.map(() => 0), count: 0, sum: 0, errors: 0 });
let ops: Record<string, Hist> = {};
let errors: Record<string, number> = {};
let firstErrors: string[] = [];
const totalErrors: Record<string, number> = {};
let inflight = 0, inflightMax = 0;

function observe(op: string, seconds: number, failed: boolean) {
  const h = ops[op] ??= newHist();
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]!) h.buckets[i]!++;
  h.count++; h.sum += seconds; if (failed) h.errors++;
}

function errorCode(e: unknown): string {
  if (e instanceof HostedToolError) return `${e.tool}:${e.code ?? "refused"}`;
  const m = e instanceof Error ? e.message : String(e);
  const status = /\b(4\d\d|5\d\d)\b/.exec(m)?.[1];
  return status ? `http_${status}` : (e instanceof Error ? e.name : "error");
}

function noteError(op: string, e: unknown) {
  const code = `${op}/${errorCode(e)}`;
  errors[code] = (errors[code] ?? 0) + 1;
  totalErrors[code] = (totalErrors[code] ?? 0) + 1;
  if (firstErrors.length < 5) firstErrors.push(`${code}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400));
}

// One timed operation. A failure is counted and swallowed: the coordinator gates on the count.
async function timed<T>(op: string, fn: () => Promise<T>): Promise<T | undefined> {
  const start = performance.now();
  inflight++; inflightMax = Math.max(inflightMax, inflight);
  try {
    const v = await fn();
    observe(op, (performance.now() - start) / 1000, false);
    return v;
  } catch (e) {
    observe(op, (performance.now() - start) / 1000, true);
    noteError(op, e);
    return undefined;
  } finally { inflight--; }
}

type Live = {
  spec: DriverSession;
  s: HostedSession;
  stopWatch?: () => Promise<void>;
  dirty: boolean;
  wake?: () => void;
  loop?: Promise<void>;
  stop: boolean;
  nextSend: number;
  seq: number;
  // The next of SVC_READS this session takes; its invocations' post ids by seq; the last invocation whose reply it read
  // and receipted, whose thread its board_read reads (a read of posts still pending for it would deliver them, #1511).
  reads: number;
  invoked: Map<number, number>;
  doneThread?: number;
  // A board_read whose turn came before the session had a thread to read: it runs once one exists.
  owedRead?: boolean;
};

const sentDm = new Set<string>();
const recvDm = new Set<string>();
const svcSent = new Set<string>(), svcGot = new Set<string>(), svcDone = new Set<string>();
const svcPosts: number[] = [];
let posts = 0, boardRecv = 0, misdelivered = 0, laneEcho = 0;
const svcReads: Record<string, ReadProof> = Object.fromEntries(PROOF_OPS.map(op => [op, { ok: 0, named: 0, content: 0 }]));
const misdeliveredFirst: string[] = [];
let sending = true;

let svcBoard: string | null = null;

function itemsOf(read: unknown): { id: string; event: unknown }[] {
  if (!read || typeof read !== "object" || !("items" in read) || !Array.isArray(read.items)) throw new Error(`the inbox read answered ${JSON.stringify(read)?.slice(0, 200)}`);
  return read.items;
}

// The pushed post's id in a board delivery ({ kind: "board", item: { kind: "push", post } }).
function postIdOf(event: unknown): number | undefined {
  const e = event as { kind?: string; item?: { kind?: string; post?: { id?: unknown } } } | null;
  return e?.kind === "board" && e.item?.kind === "push" && typeof e.item.post?.id === "number" ? e.item.post.id : undefined;
}

// One inbox pass, as the controller makes it: read, then per item a renew and its receipt. A lane answers an
// invocation before its receipt, as a worker finishes the job before it acks the delivery.
async function drain(l: Live) {
  const read = await timed("inbox", () => l.s.subscriber.read("grayboard://inbox"));
  // A failed read leaves the items on the server: try again shortly rather than at the next renewal.
  if (read === undefined) { await Bun.sleep(250); l.dirty = true; return; }
  const items = itemsOf(read);
  if (!items.length) return;
  for (const item of items) {
    const text = JSON.stringify(item.event);
    let answered: number | undefined;
    for (const m of text.matchAll(MARK)) {
      if (m[1] === "done" && l.spec.service) { laneEcho++; continue; }
      const meant = m[1] === "dm" || m[1] === "done" ? m[4] === String(l.spec.index) : m[1] === "svc" ? l.spec.service === true && m[4] === l.spec.board : m[4] === l.spec.board;
      if (!meant) {
        misdelivered++;
        if (misdeliveredFirst.length < 5) misdeliveredFirst.push(`${m[0]} read by session ${l.spec.index} (${l.spec.board})`);
        continue;
      }
      if (m[1] === "dm") {
        recvDm.add(`${m[2]}:${m[3]}`);
        observe("dm_e2e", (Date.now() - Number(m[5])) / 1000, false);
      } else if (m[1] === "svc") {
        svcGot.add(`${m[2]}:${m[3]}`);
        observe("svc_e2e", (Date.now() - Number(m[5])) / 1000, false);
        const parent = postIdOf(item.event);
        if (parent === undefined) { noteError("svc_reply", new Error(`an invocation's delivery has no post id: ${text.slice(0, 200)}`)); continue; }
        await timed("svc_reply", () => l.s.call("board_post", { board: l.spec.board, body: `lt|done|${m[2]}|${m[3]}|${m[2]}|${m[5]}`, parent_id: parent }));
      } else if (m[1] === "done") {
        svcDone.add(`${m[2]}:${m[3]}`);
        answered = l.invoked.get(Number(m[3])) ?? answered;
        // From the invocation's send to its reply's read: the round trip through the service.
        observe("svc_rtt", (Date.now() - Number(m[5])) / 1000, false);
      } else {
        boardRecv++;
        observe("post_e2e", (Date.now() - Number(m[5])) / 1000, false);
      }
    }
    await timed("renew", () => l.s.subscriber.call("delivery_renew"));
    let receipted = false;
    await timed("receipt", async () => { await l.s.receipt([item.id]); receipted = true; });
    if (receipted && answered !== undefined) l.doneThread = answered;
  }
  if (items.length === 100) l.dirty = true;
}

// The session's delivery loop: renew every 10 s and read after it, read on every hint.
async function deliveryLoop(l: Live) {
  let renewal = Date.now() + RENEW_MS;
  while (!l.stop) {
    if (l.dirty) { l.dirty = false; await drain(l); }
    if (Date.now() >= renewal) {
      await timed("renew", () => l.s.subscriber.call("delivery_renew"));
      renewal = Date.now() + RENEW_MS; l.dirty = true;
    }
    if (l.dirty || l.stop) continue;
    await new Promise<void>(resolve => { l.wake = resolve; setTimeout(resolve, Math.max(10, Math.min(1000, renewal - Date.now()))); });
    l.wake = undefined;
  }
}

// A churned session's name can still be held for a moment by the ownership it just released, as a
// restarting agent finds it: retry the bind, within a deadline.
async function open(spec: DriverSession, url: string): Promise<Live> {
  for (const deadline = Date.now() + 20_000; ;) {
    try { return await openOnce(spec, url); }
    catch (e) {
      if (!(e instanceof HostedToolError && e.code === "alias_held") || Date.now() > deadline) throw e;
      await Bun.sleep(500);
    }
  }
}

async function openOnce(spec: DriverSession, url: string): Promise<Live> {
  const s = new HostedSession(url, spec.token, spec.name, { receipt: "manual" });
  const l: Live = { spec, s, dirty: true, stop: false, nextSend: 0, seq: 0, reads: spec.index % SVC_READS.length, invoked: new Map() };
  try { await s.connect(); } catch (e) { await s.drop(); throw e; }
  // board_create subscribes its creator; whoever loses the race subscribes. A worker's board is the service's queue.
  try { await s.call("board_create", { name: spec.board, purpose: "load test", ...(spec.service ? { kind: "queue" } : {}) }); }
  catch (e) {
    if (!(e instanceof HostedToolError)) throw e;
    await s.call("board_subscribe", { board: spec.board, mode: "push" });
  }
  s.subscriber.client.setNotificationHandler("notifications/resources/updated", (n) => {
    if (n.params.uri === "grayboard://inbox") { l.dirty = true; l.wake?.(); }
  });
  const subscription = await s.subscriber.listen();
  l.stopWatch = () => subscription.close();
  l.loop = deliveryLoop(l);
  // A harness host lists the resources at its start: the catalog, judged per board (a service board's binding read).
  // Timed and proved as its own op, its latency reported but not gated: churn reconnects land it in the steady windows.
  // The session's connect time includes this round trip.
  if (svcBoard) await timed("catalog_connect", () => catalog(l, svcBoard!, "catalog_connect"));
  return l;
}

// Reads started from the first report on are proved: by then every driver is ready, so the service's board exists (a
// session that connects before the workers have created it lists a catalog without it). `counted`: proving at its start.
let proving = false;
const proved = (counted: boolean, op: string, named: boolean, content: boolean) => {
  if (!counted) return;
  const p = svcReads[op]!;
  p.ok++; if (named) p.named++; if (named && content) p.content++;
};
const postsOf = (v: unknown): { id?: unknown; body?: unknown }[] => {
  const posts = (v as { posts?: unknown } | null)?.posts;
  return Array.isArray(posts) ? posts : [];
};

// The catalog (resources/list on the native role), every page; it must list the service's board.
async function catalog(l: Live, board: string, op: "catalog" | "catalog_connect") {
  const counted = proving, uris: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await l.s.native.client.listResources(cursor === undefined ? {} : { cursor }, { ...l.s.native.options(), cacheMode: "bypass" });
    uris.push(...page.resources.map(r => r.uri));
    cursor = page.nextCursor;
    if (cursor !== undefined && seen.has(cursor)) throw new Error(`catalog: cursor ${cursor} repeated`);
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor);
  proved(counted, op, uris.includes(`grayboard://boards/${board}`), true);
}

// One read of the service's board, the next of SVC_READS in this session's turn. board_read waits for a thread to read:
// a turn that comes before the session's first answered invocation passes to the next read, and board_read is owed
// until the session has a thread. The rotation always advances, so the other reads stay in turn (with no invocations
// at all, as at --svc-share 0, they rotate among themselves).
function svcRead(l: Live, board: string) {
  const counted = proving;
  let op: typeof SVC_READS[number];
  if (l.owedRead && l.doneThread !== undefined) { op = "board_read"; l.owedRead = false; }
  else {
    op = SVC_READS[l.reads++ % SVC_READS.length]!;
    if (op === "board_read" && l.doneThread === undefined) { l.owedRead = true; op = SVC_READS[l.reads++ % SVC_READS.length]!; }
  }
  if (op === "board_list") {
    void timed(op, async () => {
      const v = await l.s.call<unknown>("board_list", {});
      const rows = Array.isArray(v) ? v : (v as { boards?: unknown } | null)?.boards;
      proved(counted, op, Array.isArray(rows) && rows.some(b => (b as { name?: unknown } | null)?.name === board), true);
    });
  } else if (op === "board_read") {
    const thread = l.doneThread!;
    void timed(op, async () => {
      const v = await l.s.call<unknown>("board_read", { board, thread });
      const posts = postsOf(v);
      proved(counted, op, (v as { board?: unknown } | null)?.board === board, posts.some(p => p.id === thread) && posts.some(p => typeof p.body === "string" && p.body.startsWith("lt|done|")));
    });
  } else if (op === "snapshot") {
    void timed(op, async () => {
      const r = await l.s.native.client.readResource({ uri: `grayboard://boards/${board}` }, { ...l.s.native.options(), cacheMode: "bypass" });
      const c = r.contents[0];
      const v: unknown = c && "text" in c ? JSON.parse(c.text) : undefined;
      proved(counted, op, (v as { board?: { name?: unknown } } | undefined)?.board?.name === board, postsOf(v).length > 0);
    });
  } else {
    void timed(op, () => catalog(l, board, "catalog"));
  }
}

// Stop the loop, drain what's left (a final pass, as an agent's last read), then release.
async function close(l: Live) {
  l.stop = true; l.wake?.();
  await l.loop;
  for (let i = 0; i < 20; i++) { l.dirty = false; await drain(l); if (!l.dirty) break; }
  await l.stopWatch?.().catch(() => {});
  await l.s.close();
}

async function main() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const lines = async function* () {
    for (;;) {
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, nl); pending = pending.slice(nl + 1); yield line; }
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
    }
  }();
  const first = await lines.next();
  if (first.done) throw new Error("no config on stdin");
  const config: DriverConfig = JSON.parse(first.value);
  svcBoard = config.svcBoard;
  const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const live = new Map<number, Live>();
  const report = (seq: number) => {
    const w: DriverWindow = { type: "window", driver: config.driver, seq, at: Date.now(), live: live.size, inflight, inflightMax, lagP99: lag.count ? lag.percentile(99) / 1e9 : 0, ops, errors, firstErrors };
    emit(w);
    ops = {}; errors = {}; firstErrors = []; inflightMax = inflight; lag.reset();
  };

  // Burst creation: `burst` sessions connecting at once, wave after wave.
  for (let i = 0; i < config.sessions.length; i += config.burst) {
    const wave = config.sessions.slice(i, i + config.burst);
    const opened = await Promise.all(wave.map(spec => timed("connect", () => open(spec, config.url))));
    for (const l of opened) if (l) live.set(l.spec.index, l);
  }
  emit({ type: "ready", driver: config.driver, live: live.size, want: config.sessions.length });

  // Agent traffic on a wall-clock schedule: an op fires when due, whether or not the last returned.
  const start = Date.now();
  for (const l of live.values()) l.nextSend = start + Math.random() * config.periodMs;
  const tick = setInterval(() => {
    if (!sending) return;
    const now = Date.now();
    for (const l of live.values()) {
      if (l.stop || l.spec.service || now < l.nextSend) continue;
      l.nextSend += config.periodMs * (0.5 + Math.random());
      if (l.nextSend < now) l.nextSend = now + config.periodMs * Math.random();
      const seq = ++l.seq, r = Math.random();
      if (r < config.postShare) {
        posts++;
        void timed("board_post", () => l.s.call("board_post", { board: l.spec.board, body: `lt|post|${l.spec.index}|${seq}|${l.spec.board}|${Date.now()}` }));
      } else if (svcBoard && r < config.postShare + config.svcShare) {
        const id = `${l.spec.index}:${seq}`, board = svcBoard;
        void timed("svc_invoke", async () => {
          const res = await l.s.call<{ post_id: number }>("board_post", { board, body: `lt|svc|${l.spec.index}|${seq}|${board}|${Date.now()}` });
          svcSent.add(id);
          svcPosts.push(res.post_id);
          l.invoked.set(seq, res.post_id);
          return res;
        });
      } else if (svcBoard && r < config.postShare + config.svcShare + config.peerShare) {
        void timed("peer_list", () => l.s.call("peer_list", {}));
      } else if (svcBoard && r < config.postShare + config.svcShare + config.peerShare + config.readShare) {
        svcRead(l, svcBoard);
      } else {
        let to = Math.floor(Math.random() * (config.addresses.length - 1));
        if (to >= l.spec.index) to++;
        const id = `${l.spec.index}:${seq}`;
        void timed("dm_send", async () => {
          const r = await l.s.call("dm_send", { to: config.addresses[to]!, body: `lt|dm|${l.spec.index}|${seq}|${to}|${Date.now()}` });
          sentDm.add(id);
          return r;
        });
      }
    }
  }, 50);

  // Churn runs beside the command loop, so quiesce and close still arrive while a wave is slow.
  let churning = Promise.resolve();
  const churn = async (fraction: number) => {
    // Close a fraction and reopen each under its name with a new session ID, as an agent restarts.
    const all = [...live.values()];
    const picked = all.sort(() => Math.random() - 0.5).slice(0, Math.round(all.length * fraction));
    for (let i = 0; i < picked.length; i += config.burst) {
      await Promise.all(picked.slice(i, i + config.burst).map(async (l) => {
        live.delete(l.spec.index);
        await timed("close", () => close(l));
        const fresh = await timed("connect", () => open(l.spec, config.url));
        if (fresh) { fresh.nextSend = l.nextSend; fresh.seq = l.seq; fresh.reads = l.reads; fresh.invoked = l.invoked; fresh.doneThread = l.doneThread; fresh.owedRead = l.owedRead; live.set(l.spec.index, fresh); }
      }));
    }
    emit({ type: "churned", driver: config.driver, count: picked.length, live: live.size });
  };

  for await (const line of lines) {
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd === "report") {
      report(Number(arg));
      proving = true;
    } else if (cmd === "churn") {
      churning = churning.then(() => churn(Number(arg)));
    } else if (cmd === "quiesce") {
      sending = false;
      clearInterval(tick);
      emit({ type: "quiesced", driver: config.driver });
    } else if (cmd === "close") {
      await churning;
      await Promise.all([...live.values()].map(l => timed("close", () => close(l))));
      live.clear();
      const f: DriverFinal = {
        type: "final", driver: config.driver, sentDm: [...sentDm], recvDm: [...recvDm], posts, boardRecv, misdelivered, misdeliveredFirst,
        svcSent: [...svcSent], svcGot: [...svcGot], svcDone: [...svcDone], svcPosts, laneEcho, svcReads, errors: totalErrors,
      };
      // The final line holds every DM id: tens of KB a pipe takes in several writes. process.exit
      // drops a write still queued, so exit only once this one has reached the pipe.
      await new Promise<void>((done, fail) => process.stdout.write(JSON.stringify(f) + "\n", e => e ? fail(e) : done()));
      break;
    }
  }
  process.exit(0);
}

if (import.meta.main) await main();
