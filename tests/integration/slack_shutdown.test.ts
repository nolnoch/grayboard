import { expect, test } from "bun:test";
import { FakeSlack } from "./fake_slack.ts";
import { TestServer } from "../support/server.ts";
import { closeSessions } from "../support/mcp.ts";
import { until } from "../support/until.ts";
import { SlackBridge } from "../../src/server/slack.ts";
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

for (const mode of ["stop", "receipt-failure", "stop-during-receipt"]) test(`hosted ${mode} after Slack HTTP success retains posted progress until receipt`, async () => {
  const slack = new FakeSlack({ channel: "D1", owner: "U1", channelType: "im" });
  const entered = deferred(), release = deferred();
  const originalFetch = globalThis.fetch;
  let held = false;
  globalThis.fetch = (async (url: any, init: any) => {
    const response = await originalFetch(url, init);
    if (!held && String(url).endsWith("chat.postMessage") && String(init?.body).includes("owned hosted question")) {
      held = true; entered.resolve(); await release.promise;
    }
    return response;
  }) as typeof fetch;
  const srv = new TestServer({ slack: { appToken: "xapp-1-test", botToken: "xoxb-test", apiUrl: slack.api } });
  let restarted: SlackBridge | undefined;
  try {
    await srv.app.slackReady;
    const token = await srv.login("you@example.com");
    const code = await srv.api(token, "POST", "/api/slack/link");
    slack.say(`link ${code.body.code}`);
    await until(() => slack.posts().find(p => p.markdown_text?.startsWith("Linked to")));
    const agent = await srv.session(token, "fe");
    const q = await agent.call("dm_send", { to: "human", body: "owned hosted question" });
    await entered.promise;
    const linked = [...(srv.app.slack as any).linked.values()][0] as any;
    const receipt = srv.app.application.receiptDirect.bind(srv.app.application);
    if (mode === "stop") srv.app.slack!.stop();
    else srv.app.application.receiptDirect = (...args) => {
      if (mode === "stop-during-receipt") {
        srv.app.slack!.stop();
        return receipt(...args);
      }
      throw new Error("controlled receipt failure");
    };
    release.resolve();
    await linked.relay.settled();
    srv.app.slack!.stop();
    expect(linked.session.active).toBe(false);
    srv.app.application.receiptDirect = receipt;
    const before = srv.app.db.prepare("SELECT * FROM slack_progress").all();
    const mapped = srv.app.db.prepare("SELECT * FROM slack_threads").all();
    expect(mapped).toHaveLength(1);
    restarted = new SlackBridge({ repo: srv.app.repo, db: srv.app.db, application: srv.app.application, appToken: "xapp-1-test", botToken: "xoxb-test", apiUrl: slack.api });
    await restarted.start();
    const next = [...(restarted as any).linked.values()][0] as any;
    await next.relay.settled();
    const posts = slack.posts().filter(p => p.markdown_text === "**fe** owned hosted question");
    expect(q.delivered_now).toBe(true);
    expect(posts).toHaveLength(1);
    expect(before).toHaveLength(1);
    expect(srv.app.db.prepare("SELECT * FROM slack_progress").all()).toHaveLength(0);
    expect(next.session.active).toBe(true);
    expect(next.relay.store.pending()).toHaveLength(0);
  } finally {
    release.resolve(); restarted?.stop();
    await closeSessions(); await srv.stop(); slack.stop(); globalThis.fetch = originalFetch;
  }
}, 20000);
