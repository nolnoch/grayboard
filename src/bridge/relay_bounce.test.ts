// A reply in a mapped DM thread whose session ended (or no longer exists) is
// worded for the Slack reader, not in session ids and alias bookkeeping (#428).
import { expect, test } from "bun:test";
import { Relay, threadBounce, type Bus, type ToolResult } from "./relay.ts";
import { Store } from "./store.ts";
import { SlackWeb, type Fetch } from "./web.ts";

const ENDED = "id:cx2k995b74z9r ended at 2026-10-30T15:00:10.516Z; it held no alias";

test("threadBounce words id_ended and not_found and leaves other refusals alone", () => {
  expect(threadBounce({ code: "id_ended", error: ENDED })).toBe("⚠️ Your reply wasn't sent: the agent session this thread was with has ended (2026-10-30T15:00:10.516Z), so replies here reach nobody. Start a new message to a named agent instead.");
  // Local mode's text carries the code in front; the clauses read the same.
  expect(threadBounce({ code: "id_ended", error: "id_ended: id:abc ended at 2026-10-30T15:00:10.516Z; it held `be`, `be-stream`" })).toBe("⚠️ Your reply wasn't sent: the agent session this thread was with has ended (2026-10-30T15:00:10.516Z), so replies here reach nobody. Its names outlive it: message `be`, `be-stream` to reach whoever holds them now.");
  expect(threadBounce({ code: "not_found", error: "no session id:abc" })).toContain("no longer exists");
  expect(threadBounce({ code: "no_delivery", error: "x" })).toBeUndefined();
  expect(threadBounce({ error: ENDED })).toBeUndefined();
});

function relayWith(result: ToolResult) {
  const store = new Store(":memory:");
  store.addThread({ thread_ts: "t.0", kind: "dm", board: null, root_id: 1, peer: "id:cx2k995b74z9r", last_id: 1 });
  const posts: Record<string, unknown>[] = [];
  const bus: Bus = { call: async () => result, attachment: async () => { throw new Error("unexpected attachment"); }, withFiles: async (_f, send) => send({}) };
  const fetch: Fetch = async (url, init) => {
    if (url.endsWith("chat.postMessage")) posts.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, ts: "status.0" });
  };
  const relay = new Relay(store, bus, new SlackWeb("xoxb-test", "http://slack.test/api/", fetch), { channel: "G1", owner: "U1", onFatal: () => {}, retryMs: 1, log: () => {} });
  const reply = async (thread?: string) => {
    await relay.onEvent({ type: "event_callback", event: { type: "message", channel: "G1", user: "U1", text: "@id:cx2k995b74z9r still there?", ts: "r.1", ...(thread ? { thread_ts: thread } : {}) } });
    await relay.settled();
  };
  return { relay, posts, reply };
}

test("a reply in a thread whose session ended is told so in the thread, in plain words", async () => {
  const f = relayWith({ ok: false, code: "id_ended", error: ENDED });
  try {
    await f.reply("t.0");
    expect(f.posts.map(p => [p.thread_ts, p.markdown_text])).toEqual([["t.0", threadBounce({ code: "id_ended", error: ENDED })]]);
  } finally { f.relay.stop(); }
});

test("an unmapped send to an ended id keeps the bus's own refusal text", async () => {
  const f = relayWith({ ok: false, code: "id_ended", error: ENDED });
  try {
    await f.reply();
    expect(f.posts.map(p => p.markdown_text)).toEqual([`⚠️ not sent: ${ENDED}`]);
  } finally { f.relay.stop(); }
});
