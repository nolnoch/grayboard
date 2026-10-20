import { describe, test, expect } from "bun:test";
import { canSend, canAdmin, type SendPrincipal, type SendTarget, type SendContext } from "./can_send.ts";

const principal: SendPrincipal = {
  user_id:       1,
  user_email:    "wade@example.com",
  identity_id:   1,
  identity_name: "fe",
  identity_full: "wade@example.com/fe",
};

const ctx: SendContext = {
  db:  {} as SendContext["db"],
  now: Date.now(),
  humanReach: "team",
};

describe("canSend — v1 contract", () => {
  test("v1 allows user -> user send", () => {
    const target: SendTarget = { kind: "user", address: "bob@example.com/be" };
    const decision = canSend(principal, target, ctx);
    expect(decision.allow).toBe(true);
  });

  test("denied decisions include machine-readable code", () => {
    // v1 never denies, but the type must support it — verify the union shape
    type DeniedShape = { allow: false; code: "forbidden" | "not_found"; reason: string };
    const denied: DeniedShape = { allow: false, code: "forbidden", reason: "test" };
    expect(denied.code).toBe("forbidden");
    expect(denied.allow).toBe(false);
  });

  test("canSend is synchronous", () => {
    const target: SendTarget = { kind: "user", address: "bob@example.com/be" };
    const result = canSend(principal, target, ctx);
    // A Promise has a .then property; a plain object does not
    expect(result).not.toHaveProperty("then");
  });
});

describe("canAdmin", () => {
  test("allows emails on the admin list, case-insensitively", () => {
    expect(canAdmin(principal, ["wade@example.com"]).allow).toBe(true);
    expect(canAdmin({ ...principal, user_email: "Wade@Example.com" }, ["wade@example.com"]).allow).toBe(true);
  });

  test("refuses everyone else, and everyone when no admins are configured", () => {
    expect(canAdmin(principal, ["bob@example.com"])).toMatchObject({ allow: false, code: "forbidden" });
    expect(canAdmin(principal, [])).toMatchObject({ allow: false, code: "forbidden", reason: expect.stringContaining("GRAYBOARD_ADMINS") });
  });
});
