import { expect, test } from "bun:test";
import { resolveRoot, SessionRoutes, type SessionNode } from "../src/sessions.js";

function fixture() {
  const nodes = new Map<string, SessionNode>();
  const calls: string[] = [];
  const add = (id: string, parentID?: string, archived?: number) => nodes.set(id, { id, parentID, time: { archived } });
  const get = async (id: string) => { calls.push(id); const node = nodes.get(id); if (!node) throw new Error("not found"); return node; };
  return { nodes, calls, add, get };
}

test("top-level and nested callers resolve to the top root, not the immediate parent", async () => {
  const f = fixture(); f.add("R"); f.add("C", "R"); f.add("G", "C");
  expect(await resolveRoot("R", f.get)).toEqual({ sessionID: "R", root: "R", via: [] });
  expect(await resolveRoot("C", f.get)).toEqual({ sessionID: "C", root: "R", via: [] });
  expect(await resolveRoot("G", f.get)).toEqual({ sessionID: "G", root: "R", via: ["C"] });
  expect(f.calls).toEqual(["R", "C", "R", "G", "C", "R"]);
});

test("ancestry fails closed on a missing caller or ancestor, repeat, or inactive node", async () => {
  const f = fixture();
  await expect(resolveRoot("missing", f.get)).rejects.toThrow("missing missing at step 1");
  f.add("G", "C");
  await expect(resolveRoot("G", f.get)).rejects.toThrow("missing C at step 2");
  f.add("C", "G");
  await expect(resolveRoot("G", f.get)).rejects.toThrow("repeats G at step 3");
  f.add("C", "C");
  await expect(resolveRoot("G", f.get)).rejects.toThrow("repeats C at step 3");
  f.add("C", undefined, 1);
  await expect(resolveRoot("G", f.get)).rejects.toThrow("inactive C at step 2");
  await expect(resolveRoot("G", async () => ({ id: "other", time: {} }))).rejects.toThrow("inactive G at step 1");
});

test("ancestry permits exactly 16 lookups, never a seventeenth", async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) f.add(String(i), i === 15 ? undefined : String(i + 1));
  const path = await resolveRoot("0", f.get);
  expect(path.root).toBe("15"); expect(path.via).toHaveLength(14); expect(f.calls).toHaveLength(16);
  f.calls.length = 0; f.add("15", "16"); f.add("16");
  await expect(resolveRoot("0", f.get)).rejects.toThrow("exceeds 16 steps");
  expect(f.calls).toHaveLength(16);
});

test("ID-only child-first deletion is idempotent and preserves a sibling descendant route", async () => {
  const routes = new SessionRoutes();
  routes.remember({ sessionID: "R", root: "R", via: [] });
  routes.remember({ sessionID: "C", root: "R", via: [] });
  routes.remember({ sessionID: "G", root: "R", via: ["C"] });
  expect(routes.end("C")).toEqual({ sessionID: "C", root: "R", via: [] });
  expect(routes.end("C")).toBeUndefined();
  expect(routes.end("G")).toEqual({ sessionID: "G", root: "R", via: ["C"] });
  expect(routes.end("R")).toEqual({ sessionID: "R", root: "R", via: [] });
  expect(routes.end("R")).toBeUndefined();
});

test("archive-before-child-delete retains routing but fences late ancestry completions", async () => {
  const routes = new SessionRoutes();
  const root = { sessionID: "R", root: "R", via: [] };
  const child = { sessionID: "C", root: "R", via: [] };
  routes.remember(root); routes.remember(child);
  routes.end("R");
  expect(() => routes.remember({ sessionID: "late", root: "R", via: [] })).toThrow("ended");
  expect(routes.end("C")).toEqual(child);
  expect(() => routes.remember(child)).toThrow("ended");
  expect(routes.end("unknown")).toBeUndefined();
  expect(() => routes.remember({ sessionID: "unknown", root: "other", via: [] })).toThrow("ended");
});

test("routes reject retargeting and defensively copy the ancestor chain", () => {
  const routes = new SessionRoutes();
  const path = { sessionID: "G", root: "R", via: ["C"] };
  routes.remember(path); path.via.push("changed");
  expect(() => routes.remember({ sessionID: "G", root: "other", via: [] })).toThrow("changed");
  expect(routes.end("G")?.via).toEqual(["C"]);
});
