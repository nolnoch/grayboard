import { expect, test } from "bun:test";
import { Relay, type Bus } from "./relay.ts";
import { Store } from "./store.ts";
import { SlackWeb } from "./web.ts";
import { sha256Hex } from "../shared/hash.ts";

for (const files of [false, true]) test(`shutdown after successful ${files ? "share" : "post"} saves mapping and progress before stopping (#207 audit 1)`, async () => {
  const store = new Store(":memory:");
  const calls: string[] = [], sent: Record<string, unknown>[] = [];
  const data = new TextEncoder().encode("attachment");
  const bus: Bus = {
    call: async (_name, args) => { sent.push(args); return { ok: true, value: { message_id: 3, delivered_now: true } }; },
    attachment: async id => ({ id, filename: "note.txt", type: "text/plain", size: data.length, sha256: sha256Hex(data), data }),
    withFiles: async (_files, send) => send({}),
  };
  const web = new SlackWeb("xoxb-test", "http://slack.test/api/", async (url) => {
    calls.push(url);
    if (url.endsWith("files.getUploadURLExternal")) return Response.json({ ok: true, upload_url: "http://slack.test/upload", file_id: "F1" });
    if (url.endsWith("files.completeUploadExternal")) return Response.json({ ok: true, files: [{ shares: { private: { G1: [{ ts: "first.0" }] } } }] });
    return Response.json({ ok: true, ts: "first.0" });
  });
  let relay!: Relay, stopped = false;
  const barrier = () => { stopped = true; relay.stop(); };
  relay = new Relay(store, bus, web, {
    channel: "G1", owner: "U1", onFatal: () => {},
    // Both callbacks run after Slack success, before postItem can store the mapping.
    debug: message => { if (!files && message.startsWith("posted ")) barrier(); },
    onFileSent: () => barrier(),
  });
  const id = store.enqueue({ content: "question", meta: { from: "fe", message_id: "2", ...(files ? { attachments: `1:note.txt text/plain ${data.length}B sha256:${sha256Hex(data)}` } : {}) } });
  const done = store.done.bind(store);
  store.done = () => { throw new Error("forced shutdown before outbox completion"); };
  try {
    await relay.drain();
    await relay.settled();
    expect(stopped).toBe(true);
    expect(store.byTs("first.0")).toMatchObject({ peer: "fe", root_id: 2, last_id: 2 });
    expect(store.progress(id)).toMatchObject({ posted: true, error: null });
    expect(store.pending()).toHaveLength(1);
    const publications = calls.length;
    store.done = done;
    const next = new Relay(store, bus, web, { channel: "G1", owner: "U1", onFatal: () => {} });
    await next.drain();
    expect(calls).toHaveLength(publications);
    expect(store.pending()).toEqual([]);
    await next.onEvent({ type: "event_callback", event: { type: "message", channel: "G1", user: "U1", text: "answer", ts: "reply.0", thread_ts: "first.0" } });
    expect(sent).toEqual([{ to: "fe", body: "answer", parent_id: 2 }]);
    expect(calls.filter(url => url.endsWith("files.completeUploadExternal"))).toHaveLength(files ? 1 : 0);
    next.stop(); await next.settled();
  } finally { relay.stop(); await relay.settled(); store.close(); }
});
