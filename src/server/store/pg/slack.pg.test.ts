// #807 P3 C11a: the Slack link writes' races on Postgres (c6c7-scope §5.2 T-C7-1/2, docs/future/postgres-server.md D3),
// through the bridges' real bodies: slack.ts's linkUser (a Slack DM `link <code>`, the code from POST /api/slack/link
// on the same pod, since codes live in each bridge's memory) and unlink(userId, slackUser) (the Slack DM `unlink`). One
// server can't race itself (one write queue), so each race runs two pods on one database (tests/support/pg_server.ts),
// each with its own FakeSlack. Pod A's link write is held inside its transaction just after its slack_links upsert, so
// it holds the lock and the row; pod B's body starts, and the race waits until B is blocked on a lock (its pool is
// gb-test-b) or done, then releases A. The end state and each bridge's Slack reply
// are asserted before the wait kind, so a race whose lock is gone fails on what it broke (B's raw 23505, a new link
// deleted), not on a timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, setDefaultTimeout, test } from "bun:test";
import { FakeSlack } from "../../../../tests/integration/fake_slack.ts";
import { describePg } from "../../../../tests/support/pg.ts";
import { blockedOrSettled, holdCall, outcome, settle, type Settled } from "../../../../tests/support/pg_race.ts";
import { pgServers } from "../../../../tests/support/pg_server.ts";
import type { TestServer } from "../../../../tests/support/server.ts";
import { until } from "../../../../tests/support/until.ts";
import type { Repo } from "../../db.ts";

// Above the pool's 5 s lock_timeout (pg/tx.ts), so a wait a broken lock leaves fails 55P03, not on Bun's 5 s timeout.
setDefaultTimeout(30_000);

const NOT_LINKED = "This Slack account isn't linked to grayboard.";
const linked = (email: string) => `Linked to \`${email}\`.`;
const taken = (email: string) => `This Slack account is linked to \`${email}\`. Send \`unlink\` first.`;

// Two pods on one fresh database, A and B, each with its own FakeSlack whose DM is `owners[i]`'s and whose users.info
// vouches `emails[i]`. Disposal stops the servers, drops the database, then stops the fakes.
async function pods(owners: [string, string], emails: [Record<string, string>, Record<string, string>]) {
  const fakes = owners.map(owner => new FakeSlack({ channel: `D-${owner}`, owner, channelType: "im" }));
  fakes.forEach((f, i) => { for (const [u, e] of Object.entries(emails[i]!)) f.emails.set(u, e); });
  try {
    const p = await pgServers(2, { overrides: i => ({ slack: { appToken: "xapp-1-t", botToken: "xoxb-t", apiUrl: fakes[i]!.api } }) });
    return {
      db: p.db, a: p.servers[0]!, b: p.servers[1]!, fa: fakes[0]!, fb: fakes[1]!,
      async [Symbol.asyncDispose]() {
        try { await p[Symbol.asyncDispose](); } finally { for (const f of fakes) f.stop(); }
      },
    };
  } catch (error) {
    for (const f of fakes) f.stop();
    throw error;
  }
}

// `email`'s link code, from `grayboard slack link` on `s`.
async function code(s: TestServer, email: string): Promise<string> {
  const r = await s.api(await s.login(email), "POST", "/api/slack/link");
  expect(r.status).toBe(200);
  return r.body.code as string;
}

// The bridge's reply that starts with `text`, from this fake's posts.
const reply = (f: FakeSlack, text: string) => f.posts().find(p => typeof p.markdown_text === "string" && p.markdown_text.startsWith(text));
const replies = (f: FakeSlack) => f.posts().map(p => p.markdown_text as string);

const links = async (s: TestServer) => (await s.app.repo.slack.links(s.app.repo.read)).map(l => [l.email, l.slack_user]);

// Each repo.write `s` starts from now on, settled, in the order they finish: B's link write, whose failure (a raw
// 23505) sends no Slack reply to wait for.
function writes(s: TestServer): Settled<unknown>[] {
  const repo = s.app.repo, orig = repo.write;
  const out: Settled<unknown>[] = [];
  repo.write = ((fn: Parameters<Repo["write"]>[0], committed?: (v: unknown) => unknown) => {
    const r = orig.call(repo, fn, committed);
    void settle(r).then(x => out.push(x));
    return r;
  }) as Repo["write"];
  return out;
}

// Holds pod `s`'s link write inside its transaction, after slack.lock and its upsert (slack.link, which only linkUser's
// write calls): a B that skips the lock still meets A's row. `reached()`: the write is there.
function holdLink(s: TestServer) {
  const held = holdCall(s.app.repo.slack, "link", { after: true });
  let reached = false;
  void held.reached.then(() => { reached = true; });
  return { held, reached: () => reached };
}

describePg("Slack link races (Postgres)", () => {
  // Mutation: slack.lock a no-op (B passes linkBySlackUser before A commits; its upsert waits on A's row, then fails
  // 23505 on slack_links_slack_user_key, so its write throws and it never answers taken).
  test("T-C7-1: two users link one Slack account at once on two pods: one links, the other is told it's taken", async () => {
    // Each pod's Slack vouches its own user for SU1, so B passes the email check and reaches the lock.
    await using p = await pods(["SU1", "SU1"], [{ SU1: "a@example.com" }, { SU1: "b@example.com" }]);
    const ca = await code(p.a, "a@example.com"), cb = await code(p.b, "b@example.com");
    const { held, reached } = holdLink(p.a);
    let waitEvent: string | null, bWrites: Settled<unknown>[];
    try {
      p.fa.say(`link ${ca}`);
      await until(reached, 5000, "A's link write held after its upsert");
      bWrites = writes(p.b);
      p.fb.say(`link ${cb}`);
      waitEvent = await blockedOrSettled(p, () => bWrites.length > 0, "B's link write blocked on a lock, or done", "b");
    } finally {
      held.open();
      held.undo();
    }
    const [bWrite] = await until(() => bWrites.length > 0 && bWrites, 5000, "B's link write settled");
    await until(() => reply(p.fa, linked("a@example.com")), 5000, "A's Linked reply");
    expect(await links(p.a)).toEqual([["a@example.com", "SU1"]]);
    // Wrapped, so a failed write's diff shows its error (toMatchObject refuses a bare string).
    expect({ b: outcome(bWrite!) }).toMatchObject({ b: { taken: { email: "a@example.com", slack_user: "SU1" } } });
    await until(() => reply(p.fb, taken("a@example.com")), 5000, "B's taken reply");
    expect(replies(p.fb).filter(t => t.startsWith(linked("b@example.com")))).toEqual([]);
    expect(waitEvent).toBe("advisory");
  });

  // Mutation: slack.lock a no-op (B's unlink reads the old SU1 link, and its delete waits on A's row, then, re-checked on
  // A's committed row by user_id only, removes the SU2 link A just made; B answers Unlinked).
  test("T-C7-2: a relink to another account on one pod, an unlink from the old one on another: the unlink answers not linked and the new link stays", async () => {
    // Pod A's DM is SU2's, pod B's SU1's; both vouch a@example.com.
    await using p = await pods(["SU2", "SU1"], [{ SU2: "a@example.com" }, { SU1: "a@example.com" }]);
    p.fb.say(`link ${await code(p.b, "a@example.com")}`);
    await until(() => reply(p.fb, linked("a@example.com")), 5000, "a's first link (SU1, on B)");
    expect(await links(p.a)).toEqual([["a@example.com", "SU1"]]);
    const ca = await code(p.a, "a@example.com");
    const before = p.fb.posts().length;
    const bReply = () => p.fb.posts().slice(before).find(x => x.markdown_text?.startsWith(NOT_LINKED) || x.markdown_text?.startsWith("Unlinked from"));
    const { held, reached } = holdLink(p.a);
    let waitEvent: string | null;
    try {
      p.fa.say(`link ${ca}`);
      await until(reached, 5000, "A's relink write held after its upsert");
      // B's pre-read sees the SU1 link (A's relink is uncommitted); its unlink(a, "SU1") waits on the lock.
      p.fb.say("unlink");
      waitEvent = await blockedOrSettled(p, () => !!bReply(), "B's unlink blocked on a lock, or answered", "b");
    } finally {
      held.open();
      held.undo();
    }
    await until(() => reply(p.fa, linked("a@example.com")), 5000, "A's Linked reply");
    const answer = await until(bReply, 5000, "B's unlink reply");
    expect(await links(p.a)).toEqual([["a@example.com", "SU2"]]);
    expect(answer.markdown_text).toStartWith(NOT_LINKED);
    expect(waitEvent).toBe("advisory");
  });
});
