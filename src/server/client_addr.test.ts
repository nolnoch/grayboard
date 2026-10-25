import { expect, spyOn, test } from "bun:test";

import { clientAddress, DEFAULT_TRUSTED_PROXIES, normalizeIp, parseCidr, rateKey, TrustedProxies } from "./client_addr.ts";

const loopback = new TrustedProxies(DEFAULT_TRUSTED_PROXIES);
const none = new TrustedProxies([]);

test("addresses normalise: IPv4-mapped IPv6 as IPv4, lowercase, no zone; junk is null", () => {
  expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
  expect(normalizeIp(" ::FFFF:10.0.0.1 ")).toBe("10.0.0.1");
  expect(normalizeIp("FE80::1%eth0")).toBe("fe80::1");
  expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
  expect(normalizeIp("unknown")).toBeNull();
  expect(normalizeIp("1.2.3.4:5678")).toBeNull();
  expect(normalizeIp("")).toBeNull();
});

test("the default trust matches the loopback peer Bun reports, mapped or not", () => {
  expect(loopback.has(normalizeIp("::ffff:127.0.0.1")!)).toBe(true);
  expect(loopback.has("127.8.9.10")).toBe(true);
  expect(loopback.has("::1")).toBe(true);
  expect(loopback.has("10.0.0.1")).toBe(false);
});

test("an untrusted peer is the address, whatever X-Forwarded-For says", () => {
  expect(clientAddress("::ffff:203.0.113.5", "198.51.100.1", loopback)).toBe("203.0.113.5");
  expect(clientAddress("::ffff:127.0.0.1", "198.51.100.1", none)).toBe("127.0.0.1");
  expect(clientAddress(null, "198.51.100.1", loopback)).toBeNull();
});

test("behind trusted proxies the walk from the right takes the first untrusted entry", () => {
  const lb = new TrustedProxies([...DEFAULT_TRUSTED_PROXIES, "10.0.0.0/8"]);
  // Caddy appended the LB's peer; a client's own entry on the left is ignored.
  expect(clientAddress("::1", "6.6.6.6, 198.51.100.1, 10.0.0.7", lb)).toBe("198.51.100.1");
  expect(clientAddress("::1", "198.51.100.1", loopback)).toBe("198.51.100.1");
  // Rightmost, not leftmost: the left is the client's to forge.
  expect(clientAddress("::1", "6.6.6.6, 198.51.100.1", loopback)).toBe("198.51.100.1");
  // No header: the peer. All trusted: the last one trusted. Junk: stop there.
  expect(clientAddress("127.0.0.1", null, loopback)).toBe("127.0.0.1");
  expect(clientAddress("127.0.0.1", "10.0.0.7", lb)).toBe("10.0.0.7");
  expect(clientAddress("127.0.0.1", "198.51.100.1, garbage", loopback)).toBe("127.0.0.1");
  expect(clientAddress("127.0.0.1", "::ffff:198.51.100.1", loopback)).toBe("198.51.100.1");
});

test("hex-mapped IPv4 normalises to dotted", () => {
  expect(normalizeIp("::ffff:7f00:1")).toBe("127.0.0.1");
  expect(normalizeIp("::FFFF:C633:6401")).toBe("198.51.100.1");
});

test("forwarded-for entries with a port or brackets parse to the address", () => {
  expect(clientAddress("::1", "198.51.100.1:5678", loopback)).toBe("198.51.100.1");
  expect(clientAddress("::1", "[2001:db8::1]", loopback)).toBe("2001:db8::1");
  expect(clientAddress("::1", "[2001:db8::1]:443", loopback)).toBe("2001:db8::1");
  expect(clientAddress("::1", " [::ffff:198.51.100.1]:80 ", loopback)).toBe("198.51.100.1");
});

test("a trusted proxy's unparsable entry keys to the proxy and is logged once", () => {
  const trusted = new TrustedProxies(DEFAULT_TRUSTED_PROXIES);
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(clientAddress("127.0.0.1", "garbage", trusted)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "more-garbage", trusted)).toBe("127.0.0.1");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain(`trusted proxy 127.0.0.1 sent an X-Forwarded-For entry that isn't an address ("garbage")`);
  } finally {
    err.mockRestore();
  }
});

test("IPv4 keys by address, IPv6 by its /64", () => {
  expect(rateKey("198.51.100.1")).toBe("198.51.100.1");
  expect(rateKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  expect(rateKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
  expect(rateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(rateKey("::1")).toBe("0:0:0:0::/64");
  expect(rateKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
});

test("CIDRs validate and normalise; a bare IP is a host route", () => {
  expect(parseCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  expect(parseCidr(" 192.0.2.1 ")).toBe("192.0.2.1/32");
  expect(parseCidr("::ffff:192.0.2.1")).toBe("192.0.2.1/32");
  expect(parseCidr("2001:DB8::/32")).toBe("2001:db8::/32");
  for (const bad of ["10.0.0.0/33", "::/129", "10.0.0.0/8/1", "10.0.0.0/", "10.0.0.0/x", "host.example", ""]) {
    expect(() => parseCidr(bad)).toThrow("is not an IP address or CIDR");
  }
});
