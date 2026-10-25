// The pi adapter's delegation translation (#243): its parser stays paired
// with the core builders (a shape change on either side fails here), and the
// persona → agent-file resolution behaves. The adapter module is imported
// with PI_CODING_AGENT_DIR pointed at a fixture, so its top-level state
// (the mcp.json entry read) never touches a real agent dir.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "grayboard-pi-adapter-"));

const { delegationBody, humanFallbackBody, parseDelegationBody } = await import("../../src/core/delegation.ts");
const { parseDelegation, resolveAgent } = await import("./grayboard.ts");

// The fixture agents dir the resolver reads: one hyphenated name, one plain.
const agentsDir = join(process.env.PI_CODING_AGENT_DIR, "agents");
mkdirSync(agentsDir, { recursive: true });
writeFileSync(join(agentsDir, "researcher.md"), "---\nmodel: fake/fake-1\n---\nYou are a researcher.\n");
writeFileSync(join(agentsDir, "doc-writer.md"), "---\n---\nYou write docs.\n");

const briefs: { requester: string; persona: string; task: string; context?: string }[] = [
  { requester: "sim", persona: "a researcher", task: "summarize the launch rules" },
  { requester: "you@example.com/sim", persona: "a doc writer", task: "draft the intro\nover two lines", context: "audience: first-time users" },
];

test("the adapter's parser parses the core builder's bodies, field for field", () => {
  for (const b of briefs) {
    expect(parseDelegation(delegationBody(b))).toEqual(b);
    expect(parseDelegationBody(delegationBody(b))).toEqual(b);
    // The human fallback carries the same data block.
    expect(parseDelegation(humanFallbackBody(b))).toEqual(b);
  }
});

test("a body that isn't a delegation parses as null, not an error", () => {
  expect(parseDelegation("ping")).toBeNull();
  expect(parseDelegationBody("ping")).toBeNull();
  // A 3-backtick json fence (any ordinary DM's code block) is not the data
  // fence, with or without the header.
  expect(parseDelegation("```json\n{\"persona\":\"x\"}\n```")).toBeNull();
  expect(parseDelegationBody("[delegation request from sim]\n```json\n{\"persona\":\"x\"}\n```")).toBeNull();
  // The header without a well-formed block: null (truncated, bad JSON, wrong fields).
  expect(parseDelegation("[delegation request from sim]\nno block")).toBeNull();
  expect(parseDelegation("[delegation request from sim]\n````json\nnot json\n````")).toBeNull();
  expect(parseDelegation('[delegation request from sim]\n````json\n{"persona":"x"}\n````')).toBeNull();
  expect(parseDelegationBody('[delegation request from sim]\n````json\n{"requester":"s","persona":"p","task":""}\n````')).toBeNull();
});

test("a task carrying ordinary code fences still parses (the data fence is four backticks)", () => {
  const b = { requester: "sim", persona: "a researcher", task: "run this:\n```js\nconsole.log(1)\n```" };
  expect(parseDelegation(delegationBody(b))).toEqual(b);
});

test("the persona resolves to an agent file: exact, article-stripped, word, substring; none → null", () => {
  expect(resolveAgent("researcher", agentsDir)).toBe("researcher");
  expect(resolveAgent("a researcher", agentsDir)).toBe("researcher");
  expect(resolveAgent("a doc-writer", agentsDir)).toBe("doc-writer");
  expect(resolveAgent("a doc-writer-ish role", agentsDir)).toBe("doc-writer");
  expect(resolveAgent("an analyst", agentsDir)).toBeNull();
  // A missing dir reads as no agents.
  expect(resolveAgent("a researcher", join(agentsDir, "nope"))).toBeNull();
});
