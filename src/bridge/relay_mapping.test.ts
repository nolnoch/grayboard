import { expect, test } from "bun:test";
import { Relay, type Bus, type ChannelParams } from "./relay.ts";
import { Store } from "./store.ts";
import { SlackWeb, type Fetch } from "./web.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(kind: "dm" | "board" = "dm") {
  const store = new Store(":memory:");
  store.addThread({ thread_ts: "be.0", kind: "dm", board: null, root_id: 1, peer: "be", last_id: 1 });
  const calls: [string, Record<string, unknown>][] = [];
  const posts: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const entered = deferred<void>();
  const answer = deferred<Response>();
  const later = deferred<Response>();
  const laterEntered = deferred<void>();
  const looked = deferred<void>();
  const byTs = store.byTs.bind(store);
  store.byTs = (ts) => {
    const row = byTs(ts);
    if (!row) looked.resolve();
    return row;
  };
  let next = 10;
  let publications = 0;
  const bus: Bus = {
    call: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, value: { message_id: next, post_id: next++, delivered_now: true, board: "ops" } };
    },
    attachment: async () => { throw new Error("unexpected attachment"); },
    withFiles: async (_files, send) => send({}),
  };
  const fetch: Fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("chat.postMessage")) {
      posts.push(body);
      if (body.markdown_text === "**fe** question" || body.markdown_text === "**fe** · #ops · question") {
        if (publications++ > 0) {
          laterEntered.resolve();
          return later.promise;
        }
        entered.resolve();
        return answer.promise;
      }
    }
    return Response.json({ ok: true, ts: "status.0" });
  };
  const relay = new Relay(store, bus, new SlackWeb("xoxb-test", "http://slack.test/api/", fetch), {
    channel: "G1", owner: "U1", onFatal: () => {}, retryMs: 1, log: message => logs.push(message),
  });
  const params: ChannelParams = { content: "question", meta: { from: "fe", ...(kind === "dm" ? { message_id: "2" } : { board: "ops", post_id: "2" }) } };
  const start = async () => {
    store.enqueue(params);
    const drain = relay.drain();
    await entered.promise;
    return { drain };
  };
  const reply = (text = "to fe", thread = "fe.0") => relay.onEvent({
    type: "event_callback", event: { type: "message", channel: "G1", user: "U1", text, ts: `reply-${text}`, thread_ts: thread },
  });
  const release = () => answer.resolve(Response.json({ ok: true, ts: "fe.0" }));
  const releaseLater = () => later.resolve(Response.json({ ok: true, ts: "later.0" }));
  return { store, relay, calls, posts, logs, looked, answer, start, reply, release, releaseLater, laterEntered };
}

for (const kind of ["dm", "board"] as const) {
  test(`mapping: ${kind} reply waits for the already-published post's response (#207)`, async () => {
    const f = fixture(kind);
    try {
      const { drain } = await f.start();
      const first = f.reply();
      const second = f.reply("again");
      await f.looked.promise;
      expect(f.calls).toEqual([]);
      expect(f.posts).toHaveLength(1);
      expect(f.store.byTs("fe.0")).toBeFalsy();
      f.release();
      await Promise.all([drain, first, second]);
      const tool = kind === "dm" ? "dm_send" : "board_post";
      const target = kind === "dm" ? { to: "fe" } : { board: "ops" };
      expect(f.calls).toEqual([
        [tool, { ...target, body: "to fe", parent_id: 2 }],
        [tool, { ...target, body: "again", parent_id: 10 }],
      ]);
      expect(f.store.byTs("fe.0")).toMatchObject({ kind, root_id: 2, last_id: 11 });
      expect(f.store.byTs("be.0")).toMatchObject({ peer: "be", root_id: 1, last_id: 1 });
      expect(f.posts).toHaveLength(1);
    } finally {
      f.release();
      f.relay.stop();
      f.store.close();
    }
  });
}

test("mapping: mapped replies do not wait for another thread's post (#207)", async () => {
  const f = fixture();
  try {
    const { drain } = await f.start();
    await f.reply("to be", "be.0");
    expect(f.calls).toEqual([["dm_send", { to: "be", body: "to be", parent_id: 1 }]]);
    f.release();
    await drain;
  } finally {
    f.release();
    f.relay.stop();
    f.store.close();
  }
});

test("mapping: a genuinely unknown thread gets an immediate hint with no publication (#207)", async () => {
  const f = fixture();
  try {
    await f.reply();
    expect(f.calls).toEqual([]);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.markdown_text).toContain("This thread isn't connected");
  } finally {
    f.relay.stop();
    f.store.close();
  }
});

for (const failure of ["error", "fatal", "throw", "stop"] as const) {
  test(`mapping: ${failure} settles the pending reply without retargeting (#207)`, async () => {
    const f = fixture();
    try {
      const { drain } = await f.start();
      const reply = f.reply();
      await f.looked.promise;
      expect(f.posts).toHaveLength(1);
      if (failure === "stop") {
        f.relay.stop();
        await reply;
        expect(f.posts).toHaveLength(2);
        expect(f.posts[1]!.markdown_text).toContain("Not sent: the bridge stopped");
        expect(f.logs).toContain('slack: reply "reply-to fe" in thread "fe.0" not sent: relay stopped while awaiting mapping');
        let settled = false;
        const closing = f.relay.settled().then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        f.release();
        await Promise.all([drain, closing]);
        expect(f.store.byTs("fe.0")).toMatchObject({ root_id: 2, last_id: 2 });
        expect(f.store.pending()).toEqual([]);
        expect(f.calls).toEqual([]);
        return;
      }
      if (failure === "throw") f.answer.reject(new Error("lost response"));
      else f.answer.resolve(Response.json({ ok: false, error: failure === "fatal" ? "invalid_auth" : "msg_too_long" }));
      await reply;
      expect(f.calls).toEqual([]);
      if (failure === "fatal" || failure === "throw") f.relay.stop();
      await drain;
      expect(f.store.byTs("fe.0")).toBeFalsy();
      expect(f.posts[1]!.markdown_text).toContain("This thread isn't connected");
    } finally {
      f.release();
      f.relay.stop();
      f.store.close();
    }
  });
}

test("mapping: a missing thread waits for one publication, not subsequent posts (#207)", async () => {
  const f = fixture();
  try {
    const { drain } = await f.start();
    const reply = f.reply("unknown", "unknown.0");
    await f.looked.promise;
    f.relay.notify({ content: "question", meta: { from: "fe", message_id: "3" } });
    f.release();
    await reply;
    expect(f.calls).toEqual([]);
    expect(f.posts.some(p => String(p.markdown_text).includes("This thread isn't connected"))).toBe(true);
    await f.laterEntered.promise;
    expect(f.store.byTs("later.0")).toBeFalsy();
    f.releaseLater();
    await drain;
  } finally {
    f.release();
    f.releaseLater();
    f.relay.stop();
    f.store.close();
  }
});
