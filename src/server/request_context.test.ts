import { expect, test } from "bun:test";
import { detached, inRequest, requestOrigin } from "./request_context.ts";

const o = { ip: "203.0.113.7", ua: "t" };
const later = <T>(fn: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(fn()), 1));

// A timer a request arms runs as that request's work; one armed through
// detached runs as no request's (the claim-expiry timer, application.ts).
test("a request's origin follows its awaits and timers, and detached leaves it", async () => {
  expect(requestOrigin()).toBeUndefined();
  const seen = await inRequest(o, async () => {
    await Promise.resolve();
    const inherited = await later(requestOrigin);
    const left = await detached(() => later(requestOrigin));
    return { inherited, left };
  });
  expect(seen).toEqual({ inherited: o, left: undefined });
});
