// #430: the diagnostics vocabulary. The refusals and the busy refresh map to
// their own codes and messages, and the records a host's login, login link, logout,
// refresh and tool-proxy reports write keep their operation and code instead
// of reading as invalid ("Diagnostic record unavailable").
import { expect, test } from "bun:test";
import { Diagnostics, failureCode, failureMessage, logFields, type RecordStatus } from "../src/diagnostics.js";
import { DeliveryHeldElsewhere, RefreshInProgress, ServerOutdated } from "../src/model.js";
import { ServerBusy, ServerUnreachable, subscriberError } from "../src/wire.js";

test("failureCode and failureMessage name a delivery held elsewhere, an outdated server and a busy refresh", () => {
  const hint = "run /grayboard resume";
  expect([new DeliveryHeldElsewhere("pi"), new ServerOutdated("pi"), new RefreshInProgress("pi")].map(e => [failureCode(e), failureMessage(e, hint)])).toEqual([
    ["delivery_held_elsewhere", "another pi process holds delivery for this session"],
    ["server_outdated", "this grayboard server predates the pi adapter; update the server"],
    ["refresh_in_progress", "token refresh in progress in another pi process; run /grayboard resume"],
  ]);
});

// #1553: a server at capacity is still an outage to retry (a ServerUnreachable), but reported as what it is.
test("failureCode and failureMessage tell a busy server from an unreachable one", () => {
  const hint = "run /grayboard resume";
  expect([new ServerBusy(800), new ServerUnreachable(new Error("down"))].map(e => [failureCode(e), failureMessage(e, hint)])).toEqual([
    ["server_busy", "Server at capacity; run /grayboard resume"],
    ["server_unreachable", "Server unreachable; run /grayboard resume"],
  ]);
});

test("login, login link, logout, refresh and tool-proxy records keep their operation and code, emitted and persisted", async () => {
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
    // The shared sign-in link's records (#596): plain callbacks today.
    { operation: "login_link", code: "refused", sessionID: "g" },
    { operation: "login_link", code: "operation_failed", sessionID: "h" },
  ];
  for (const w of written) d.record({ state: "degraded", message: `${w.operation} failed`, ...w });
  await d.flush();
  const expected = written.map(w => ({ operation: w.operation, code: w.code, message: `${w.operation} failed` }));
  expect(emitted.map(r => ({ operation: r.operation, code: r.code, message: r.message }))).toEqual(expected);
  const stored = saved.get("diagnostics:v1") as unknown[];
  expect(stored.map(r => logFields(r))).toEqual(written.map(w => expect.objectContaining({ operation: w.operation, code: w.code, root: w.sessionID })));
});

// #1349: a session_register refusal keeps its own code through failureCode and the record validator (logFields runs the same projection a restore does).
test("session_register's refusal codes are diagnostic codes a record keeps", () => {
  for (const code of ["child_bound", "child_registered_elsewhere", "has_children", "root_is_child", "invalid_registration"]) {
    const error = subscriberError({ code }, false);
    expect([code, failureCode(error), failureMessage(error, "run /grayboard resume")]).toEqual([code, code, `Operation refused (${code})`]);
    expect(logFields({ state: "degraded", message: "child_register failed", operation: "child_register", time: Date.now(), code })).toMatchObject({ code });
    // logFields doesn't echo `failure`, but drops the whole record when its code isn't code-shaped (#1361).
    const withFailure = (c: string) => logFields({ state: "active", message: "ok", operation: "child_register", time: Date.now(), failure: { operation: "child_register", code: c, time: Date.now() } });
    expect(withFailure(code)).toMatchObject({ operation: "child_register", state: "active" });
  }
  expect(logFields({ state: "active", message: "ok", operation: "child_register", time: Date.now(), failure: { operation: "child_register", code: "Not a code!", time: Date.now() } })).toBeUndefined();
});

// #1361: a record a newer build saved with a code this build doesn't know is kept on restore, its code read as
// operation_failed, rather than the root's last diagnostic being dropped; a fresh record still needs a known code.
test("a restored record with an unknown code-shaped code is kept as operation_failed; a malformed one is still dropped", async () => {
  const time = Date.now();
  const stored = [
    { state: "degraded", message: "x", operation: "child_register", time, sessionID: "newer", code: "some_future_code", failure: { operation: "child_register", code: "some_future_code", time } },
    { state: "degraded", message: "x", operation: "child_register", time, sessionID: "malformed", code: "Not a code!" },
    { state: "degraded", message: "x", operation: "child_register", time, sessionID: "known", code: "child_bound" },
  ];
  const saved = new Map<string, unknown>([["diagnostics:v1", stored]]);
  const d = new Diagnostics({ get: async key => saved.get(key), set: async (key, value) => { saved.set(key, value); } }, undefined, { knownRoot: /^[a-z]+$/ });
  await d.restore();
  expect(d.status().roots.map(r => [r.sessionID, r.code, r.failure?.code, r.message])).toEqual([
    ["newer", "operation_failed", "operation_failed", "Saved degraded status (operation_failed); approval is unchanged"],
    ["known", "child_bound", undefined, "Saved degraded status (child_bound); approval is unchanged"],
  ]);
  // A fresh record's code isn't mapped: an unknown one makes the record unavailable, as before.
  d.record({ state: "degraded", message: "y", operation: "child_register", sessionID: "fresh", code: "some_future_code" });
  expect(d.status().roots.at(-1)).toMatchObject({ message: "Diagnostic record unavailable; approval is unchanged", operation: "delivery" });
});
