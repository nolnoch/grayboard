// #1583: a grant id that starts with '-' reaches `grants revoke` as its operand, and nothing else changes.
import { expect, test } from "bun:test";
import { protectGrantIds } from "./argv.ts";

const head = ["bun", "grayboard"];
const id = (prefix: string) => (prefix + "A".repeat(43)).slice(0, 43);

test("a '-'-leading grant id after grants revoke moves behind --, wherever --user and the global options sit", () => {
  // -h and -V are the worst: a parent command's combined short flags print help or the version and exit 0.
  for (const prefix of ["-n", "-h", "-V", "--"]) {
    const g = id(prefix);
    expect(g).toHaveLength(43);
    expect(protectGrantIds([...head, "grants", "revoke", g])).toEqual([...head, "grants", "revoke", "--", g]);
    expect(protectGrantIds([...head, "--json", "grants", "revoke", g, "--user", "a@example.com"]))
      .toEqual([...head, "--json", "grants", "revoke", "--user", "a@example.com", "--", g]);
    expect(protectGrantIds([...head, "grants", "revoke", "--user", "a@example.com", g]))
      .toEqual([...head, "grants", "revoke", "--user", "a@example.com", "--", g]);
  }
});

test("everything else comes back unchanged: other commands, unknown flags, wrong lengths, and an argv that already has --", () => {
  const g = id("-");
  for (const argv of [
    [...head, "grants", "revoke", "AbC" + "x".repeat(40)],
    [...head, "grants", "revoke", "cli:12"],
    [...head, "grants", "revoke", "--bogus"],
    [...head, "grants", "revoke", g.slice(0, 42)],
    [...head, "grants", "revoke", g + "x"],
    [...head, "grants", "revoke", "--", g],
    [...head, "grants", "list", g],
    [...head, "claim", "take", g],
    [...head, "--", "grants", "revoke", g],
  ]) expect(protectGrantIds(argv)).toBe(argv);
});
