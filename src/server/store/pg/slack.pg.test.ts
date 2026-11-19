// #807 P3 C67b: the Slack link writes' races on Postgres (c6c7-scope §5.2 T-C7-1/2, docs/future/postgres-server.md D3),
// each in T-P12's shape (tests/support/pg_race.ts): A's body holds its transaction open at a gate, B's starts, and the
// race waits until B is blocked on a lock or done. slack.ts's linkUser and unlink bodies reach aliases, boards, teams
// and Slack I/O, which have no Postgres Repo before C11, so these race stand-ins of their Slack-store steps (the lock,
// the read it decides on, the write) over the real store; C11 replaces them with the real bodies, and
// tests/integration/slack_org.test.ts pins that those bodies lock before their first Slack read. The end state is
// asserted before `waited`, so a race whose lock is gone fails on what it broke (a raw 23505, a new link deleted), not
// on a timeout. Without GRAYBOARD_TEST_PG_URL they skip.
import { expect, test } from "bun:test";
import { describePg } from "../../../../tests/support/pg.ts";
import { committed, outcome, pgPair, race, type PgPair } from "../../../../tests/support/pg_race.ts";
import type { Tx } from "../tx_base.ts";
import { makePgSlack } from "./slack.ts";
import { int8 } from "./sql.ts";

const slack = makePgSlack({ clock: () => 1_800_000_000_000 });

const user = async (p: PgPair, email: string) => int8((await p.db.sql`INSERT INTO users (email, created_at) VALUES (${email}, 0) RETURNING id`)[0].id);
const links = async (p: PgPair) => (await slack.links(p.a.read)).map(l => [l.user_id, l.slack_user]);

// linkUser's write (slack.ts): the lock, the account's link, then the link unless another user has it.
const linkBody = (userId: number, slackUser: string) => async (tx: Tx) => {
  await slack.lock(tx);
  const taken = await slack.linkBySlackUser(tx, slackUser);
  if (taken && taken.user_id !== userId) return `taken by ${taken.email}`;
  await slack.link(tx, userId, slackUser, `D-${slackUser}`);
  return "linked";
};
// unlink(userId, slackUser), the Slack `unlink` command: the lock, the user's link, then the unlink only while it is
// still that account's.
const unlinkBody = (userId: number, slackUser: string) => async (tx: Tx) => {
  await slack.lock(tx);
  const link = await slack.linkFor(tx, userId);
  if (!link || link.slack_user !== slackUser) return false;
  await slack.unlink(tx, userId);
  return true;
};

describePg("Slack link races (Postgres)", () => {
  // Mutation: slack.lock a no-op (both pass linkBySlackUser; B's upsert fails 23505 on slack_links_slack_user_key).
  test("T-C7-1: two users link one Slack account at once: one links, the other is told it's taken", async () => {
    await using p = await pgPair();
    const a = await user(p, "a@example.com"), b = await user(p, "b@example.com");
    const r = await race(p, linkBody(a, "SU1"), linkBody(b, "SU1"));
    expect(committed(r.a)).toBe("linked");
    expect(outcome(r.b)).toBe("taken by a@example.com");
    expect(await links(p)).toEqual([[a, "SU1"]]);
    expect(r.waitEvent).toBe("advisory");
  });

  // Mutation: slack.lock a no-op (B reads the old SU1 link, and its delete, re-checked on A's committed row by user_id
  // only, removes the SU2 link A just made).
  test("T-C7-2: a relink to another account, then an unlink naming the old one: the unlink answers false and the new link stays", async () => {
    await using p = await pgPair();
    const a = await user(p, "a@example.com");
    await p.a.write(linkBody(a, "SU1"));
    const r = await race(p, linkBody(a, "SU2"), unlinkBody(a, "SU1"));
    expect(committed(r.a)).toBe("linked");
    expect(outcome(r.b)).toBe(false);
    expect(await links(p)).toEqual([[a, "SU2"]]);
    expect(r.waitEvent).toBe("advisory");
  });
});
