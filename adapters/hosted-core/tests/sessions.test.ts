// #567: SessionRoutes keeps a bounded set of ended sessions, oldest end first. #1166: and a bounded set of orphans,
// descendants of an ended root.
import { expect, test } from "bun:test";
import { SessionRoutes } from "../src/sessions.js";

test("SessionRoutes forgets the oldest end past its limit, and still refuses a recent one", () => {
  const routes = new SessionRoutes(2);
  for (const id of ["A", "B", "C"]) routes.end(id);
  expect(["A", "B", "C"].map(id => routes.isEnded(id))).toEqual([false, true, true]);
  // A forgotten end routes again; a kept one still refuses.
  routes.remember({ sessionID: "A", root: "R", via: [] });
  expect(routes.get("A")).toEqual({ sessionID: "A", root: "R", via: [] });
  expect(() => routes.remember({ sessionID: "C", root: "R", via: [] })).toThrow("ended");
  expect(() => routes.remember({ sessionID: "X", root: "B", via: [] })).toThrow("ended");
});

test("an ended root's descendants keep their paths up to the limit, oldest root end forgotten first (#1166)", () => {
  const routes = new SessionRoutes(2);
  routes.remember({ sessionID: "R", root: "R", via: [] });
  routes.remember({ sessionID: "C", root: "R", via: [] });
  routes.remember({ sessionID: "G", root: "R", via: ["C"] });
  routes.remember({ sessionID: "Q", root: "Q", via: [] });
  routes.remember({ sessionID: "S", root: "Q", via: [] });
  routes.end("R");
  // Each orphan's own end still returns its path, so it still ends its registration.
  expect(routes.end("C")).toEqual({ sessionID: "C", root: "R", via: [] });
  expect(routes.get("G")).toEqual({ sessionID: "G", root: "R", via: ["C"] });
  // A second root's orphans push the total past the limit: the oldest (G, from R's end) is forgotten.
  routes.remember({ sessionID: "T", root: "Q", via: [] });
  routes.end("Q");
  expect(["G", "S", "T"].map(id => routes.get(id)?.sessionID)).toEqual([undefined, "S", "T"]);
  expect(routes.end("G")).toBeUndefined();
  expect(() => routes.remember({ sessionID: "G", root: "R", via: ["C"] })).toThrow("ended");
});

test("one root's descendants past the limit: the earliest remembered is forgotten (#1166)", () => {
  const routes = new SessionRoutes(2);
  routes.remember({ sessionID: "R", root: "R", via: [] });
  for (const id of ["A", "B", "C"]) routes.remember({ sessionID: id, root: "R", via: [] });
  routes.end("R");
  expect(["A", "B", "C"].map(id => routes.get(id)?.sessionID)).toEqual([undefined, "B", "C"]);
});

test("a live root's descendants are not orphans and are never forgotten (#1166)", () => {
  const routes = new SessionRoutes(1);
  routes.remember({ sessionID: "R", root: "R", via: [] });
  for (const id of ["A", "B", "C"]) routes.remember({ sessionID: id, root: "R", via: [] });
  routes.end("A"); routes.end("X"); routes.end("Y");
  expect(["R", "B", "C"].map(id => routes.get(id)?.sessionID)).toEqual(["R", "B", "C"]);
});
