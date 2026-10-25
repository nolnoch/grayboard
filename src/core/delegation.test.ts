import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { declareHuman, startSession, touchHandle } from "./boards.ts";
import { delegationBody, humanFallbackBody, isLauncher, launchers, resolveDelegation, setLauncher, DELEGATE_TOOL } from "./delegation.ts";
import { CoreError } from "./errors.ts";
import { initCoreSchema } from "./schema.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initCoreSchema(db);
});

// A session on the roster, its launcher flag per the test's need. The row
// describes the live session, so startSession then setLauncher is the order
// both modes use.
function session(name: string, launcher = false, seen = true): void {
  if (seen) startSession(db, name, null);
  else touchHandle(db, name);
  setLauncher(db, name, launcher);
}

const live = (h: string) => h !== "dead";
const online = (h: string) => h !== "dead" && h !== "sleepy";

describe("launchers", () => {
  test("lists only opted-in, non-human handles", () => {
    session("a", true);
    session("b", false);
    startSession(db, "human", null);
    db.prepare(`UPDATE handles SET human = 1 WHERE name = 'human'`).run();
    setLauncher(db, "human", true);
    expect(launchers(db)).toEqual(["a"]);
  });

  test("isLauncher: only the flag", () => {
    session("a", true);
    session("b", false);
    expect(isLauncher(db, "a")).toBe(true);
    expect(isLauncher(db, "b")).toBe(false);
    expect(isLauncher(db, "nobody")).toBe(false);
  });
});

describe("resolveDelegation", () => {
  const args = { persona: "a researcher", task: "read the spec and summarize" };

  test("explicit to: a live launcher", () => {
    session("a", true);
    const d = resolveDelegation(db, "me", { ...args, to: "a" }, live);
    expect(d.to).toBe("a");
    expect(d.body).toContain("[delegation request from me]");
    expect(d.body).toContain("Persona: a researcher");
    expect(d.body).toContain("Task: read the spec and summarize");
  });

  test("explicit to: not a launcher names the flag", () => {
    session("b", false);
    expect(() => resolveDelegation(db, "me", { ...args, to: "b" }, live)).toThrow(/isn't a launcher session/);
  });

  test("explicit to: offline launcher", () => {
    session("a", true);
    expect(() => resolveDelegation(db, "me", { ...args, to: "a" }, (h) => h !== "a")).toThrow(/offline/);
  });

  test("explicit to: unknown handle", () => {
    expect(() => resolveDelegation(db, "me", { ...args, to: "nobody" }, live)).toThrow(/ever connected/);
  });

  test("auto-pick: the first live launcher by name, the requester excluded", () => {
    session("a", true);
    session("b", true);
    session("sleepy", true);
    const d = resolveDelegation(db, "me", args, online);
    expect(d.to).toBe("a");
    expect(d.humanFallback).toBeUndefined();
  });

  test("auto-pick: an offline launcher is skipped", () => {
    session("dead", true);
    session("a", true);
    const d = resolveDelegation(db, "me", args, online);
    expect(d.to).toBe("a");
  });

  test("no live launcher: falls back to a human that has connected", () => {
    declareHuman(db, "human");
    startSession(db, "human", null);
    const d = resolveDelegation(db, "me", args, online);
    expect(d.to).toBe("human");
    expect(d.humanFallback).toBe(true);
    expect(d.body).toContain("no launcher session is live");
  });

  test("server-style caller with no human row: refused (their user's human is the only fallback)", () => {
    // Another user's human connected, but the fallback is the caller's own
    // user's human, which has no row (their Slack was never linked).
    startSession(db, "other@example.com/human", null);
    expect(() => resolveDelegation(db, "you@example.com/me", args, online)).toThrow(/no live launcher session/);
  });

  test("no launcher at all and no human: refused", () => {
    session("b", false);
    expect(() => resolveDelegation(db, "me", args, online)).toThrow(/no live launcher session/);
  });

  test("field limits", () => {
    session("a", true);
    expect(() => resolveDelegation(db, "me", { persona: "", task: "t" }, live)).toThrow(/persona/);
    expect(() => resolveDelegation(db, "me", { persona: "p".repeat(81), task: "t" }, live)).toThrow(/persona/);
    expect(() => resolveDelegation(db, "me", { persona: "p", task: "" }, live)).toThrow(/task/);
    expect(() => resolveDelegation(db, "me", { persona: "p", task: "t".repeat(8001) }, live)).toThrow(/task/);
    expect(() => resolveDelegation(db, "me", { persona: "p", task: "t", context: "c".repeat(4001) }, live)).toThrow(/context/);
  });

  test("server-style human fallback: the caller's own user's human handle", () => {
    // Server handles are user@org/name; the fallback is the caller's user's
    // human, not another user's.
    startSession(db, "you@example.com/human", null);
    startSession(db, "other@example.com/human", null);
    const d = resolveDelegation(db, "you@example.com/me", args, online);
    expect(d.to).toBe("you@example.com/human");
    expect(d.humanFallback).toBe(true);
  });
});

describe("payload", () => {
  test("carries the persona and task, never a model name; the floor is parent relay", () => {
    const body = delegationBody({ requester: "me", persona: "a researcher", task: "do the thing" });
    expect(body).toContain("Persona: a researcher");
    expect(body).toContain("Task: do the thing");
    expect(body).toContain("never names a model");
    expect(body).toContain("parent relay".replace("parent relay", "you relaying for it"));
    expect(body).toContain("one delivery owner per handle");
    expect(body).toContain("Reply in this thread");
    expect(body).toContain("dm_send to me");
  });

  test("context rides along", () => {
    const body = delegationBody({ requester: "me", persona: "p", task: "t", context: "the repo is at /srv" });
    expect(body).toContain("Context: the repo is at /srv");
  });

  test("human fallback names the missing launcher and the flag", () => {
    const body = humanFallbackBody({ requester: "me", persona: "p", task: "t" });
    expect(body).toContain("BUS_LAUNCHER=1");
    expect(body).toContain("no launcher session is live");
  });
});

test("the tool def requires persona and task only", () => {
  expect(DELEGATE_TOOL.inputSchema.required).toEqual(["persona", "task"]);
});
