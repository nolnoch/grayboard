import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { savedClientMetadata } from "./cimd-fixture.js";

const source = JSON.parse(readFileSync(new URL("./fixtures/opencode-client.source.json", import.meta.url), "utf8")) as { url: string; fetchedAt: string; sha256: string; bytes: number };
test("hermetic CIMD reader returns the exact fetched document with recorded provenance", () => {
  let network = false;
  const rejectNetwork = Object.assign(() => { network = true; throw new Error("Fixture must not use network"); }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(rejectNetwork);
  try {
    const text = savedClientMetadata(new URL(source.url));
    const saved = readFileSync(new URL("./fixtures/opencode-client.json", import.meta.url));
    expect(Buffer.from(text).equals(saved)).toBe(true);
    expect(saved.length).toBe(source.bytes);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(source.sha256);
    expect(Number.isFinite(Date.parse(source.fetchedAt))).toBe(true);
    expect(network).toBe(false);
  } finally { fetch.mockRestore(); }
});
test("saved real metadata retains all native redirects and advertised client fields", () => {
  const value = JSON.parse(savedClientMetadata(new URL(source.url)));
  expect(value.client_id).toBe(source.url);
  expect(value.redirect_uris).toEqual(["http://127.0.0.1/callback", "http://localhost/callback", "http://127.0.0.1/mcp/oauth/callback"]);
  expect(value.client_uri).toBe("https://opencode.ai");
  expect(value.logo_uri).toBe("https://opencode.ai/web-app-manifest-512x512.png");
  expect(value.application_type).toBe("native");
  expect(value.token_endpoint_auth_method).toBe("none");
  expect(value.token_endpoint_auth_methods_supported).toEqual(["none"]);
  expect(value.grant_types).toEqual(["authorization_code", "refresh_token"]);
  expect(value.response_types).toEqual(["code"]);
  expect(() => savedClientMetadata(new URL("https://other.example.com/client.json"))).toThrow("Unexpected fixture CIMD URL");
});
