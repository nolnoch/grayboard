// #430: the diagnostics vocabulary. The refusals and the busy refresh map to
// their own codes and messages, and the records a host's login, logout,
// refresh and tool-proxy reports write keep their operation and code instead
// of reading as invalid ("Diagnostic record unavailable").
import { expect, test } from "bun:test";
import { Diagnostics, failureCode, failureMessage, logFields, type RecordStatus } from "../src/diagnostics.js";
import { DeliveryHeldElsewhere, RefreshInProgress, ServerOutdated } from "../src/model.js";

test("failureCode and failureMessage name a delivery held elsewhere, an outdated server and a busy refresh", () => {
  const hint = "run /grayboard resume";
  expect([new DeliveryHeldElsewhere("pi"), new ServerOutdated("pi"), new RefreshInProgress("pi")].map(e => [failureCode(e), failureMessage(e, hint)])).toEqual([
    ["delivery_held_elsewhere", "another pi process holds delivery for this session"],
    ["server_outdated", "this grayboard server predates the pi adapter; update the server"],
    ["refresh_in_progress", "token refresh in progress in another pi process; run /grayboard resume"],
  ]);
});

test("login, logout, refresh and tool-proxy records keep their operation and code, emitted and persisted", async () => {
  const saved = new Map<string, unknown>();
  const emitted: RecordStatus[] = [];
  const d = new Diagnostics({ get: async key => saved.get(key), set: async (key, value) => { saved.set(key, value); } }, record => { emitted.push(record); });
  const written = [
    { operation: "login", code: "revoke_queued", sessionID: "a" },
    { operation: "logout", code: "revoke_queued", sessionID: "b" },
    { operation: "refresh", code: "refresh_outcome_unknown", sessionID: "c" },
    { operation: "refresh", code: "refresh_in_progress", sessionID: "d" },
    { operation: "after", code: "operation_failed", sessionID: "e" },
    { operation: "release_upload", code: "operation_failed", sessionID: "f" },
  ];
  for (const w of written) d.record({ state: "degraded", message: `${w.operation} failed`, ...w });
  await d.flush();
  const expected = written.map(w => ({ operation: w.operation, code: w.code, message: `${w.operation} failed` }));
  expect(emitted.map(r => ({ operation: r.operation, code: r.code, message: r.message }))).toEqual(expected);
  const stored = saved.get("diagnostics:v1") as unknown[];
  expect(stored.map(r => logFields(r))).toEqual(written.map(w => expect.objectContaining({ operation: w.operation, code: w.code, root: w.sessionID })));
});
