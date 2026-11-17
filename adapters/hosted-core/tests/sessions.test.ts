// #567: SessionRoutes keeps a bounded set of ended sessions, oldest end first.
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
