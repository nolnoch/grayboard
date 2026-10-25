import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalKeys, renderTs, spliceSh } from "../../scripts/release_keys.ts";
import { ROOT } from "../../tests/support/paths.ts";
import { sign, testKey, testKeys } from "../../tests/support/release_keys.ts";
import { RELEASE_KEYS } from "./release_keys.ts";
import { derToP1363, parseSums, verifySums } from "./release_verify.ts";
import { keyId } from "./spki.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const HEX = "a".repeat(64);
const SUMS_TEXT = `# grayboard v1.2.3\n${HEX}  grayboard-linux-x64\n${"b".repeat(64)}  install.sh\n`;

// Signed by the openssl CLI (tests/support/release_keys.ts), as release.yml signs.
describe("verifySums", () => {
  test("accepts openssl's signature and returns the tag, key and digests", async () => {
    const r = await verifySums("v1.2.3", enc(SUMS_TEXT), sign(SUMS_TEXT), testKeys());
    expect(r.keyId).toBe(testKey().id);
    expect(r.digests.get("grayboard-linux-x64")).toBe(HEX);
    expect(r.digests.size).toBe(2);
  });

  test("a list holding two keys accepts either", async () => {
    expect((await verifySums("v1.2.3", enc(SUMS_TEXT), sign(SUMS_TEXT, testKey("b")), testKeys())).keyId).toBe(testKey("b").id);
  });

  test("many signatures: every DER length openssl emits converts (r or s with a 0x00 pad, or short)", async () => {
    // ~half of signatures pad r or s to 33 bytes, ~1/128 drop to 31: 40 runs cover the padded case.
    const lens = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const text = `${SUMS_TEXT}${"c".repeat(64)}  x${i}\n`;
      const sig = sign(text);
      lens.add(Buffer.from(sig.split(" ")[1]!, "base64").length);
      await verifySums("v1.2.3", enc(text), sig, testKeys());
    }
    expect([...lens].some((n) => n > 70)).toBe(true);
  });

  test("refusals name the check", async () => {
    const keys = testKeys();
    const good = sign(SUMS_TEXT);
    const refuse = (tag: string, text: string, sig: string) => verifySums(tag, enc(text), sig, keys);
    await expect(refuse("v1.2.3", SUMS_TEXT, sign(SUMS_TEXT, testKey("c")))).rejects.toThrow(`SHA256SUMS.sig: unknown key id ${testKey("c").id}`);
    await expect(refuse("v1.2.3", SUMS_TEXT.replace("a", "b"), good)).rejects.toThrow("the signature doesn't verify");
    await expect(refuse("v1.2.4", SUMS_TEXT, good)).rejects.toThrow("SHA256SUMS is signed for v1.2.3, not v1.2.4");
    await expect(refuse("v1.2.3", SUMS_TEXT, "")).rejects.toThrow('isn\'t "<key id> <base64 signature>"');
    await expect(refuse("v1.2.3", SUMS_TEXT, `${good.trim()} extra`)).rejects.toThrow('isn\'t "<key id> <base64 signature>"');
    // Well-formed line, but the base64 isn't a DER signature.
    await expect(refuse("v1.2.3", SUMS_TEXT, `${testKey().id} AAAAAAAA\n`)).rejects.toThrow("SHA256SUMS.sig: malformed signature (");
    // The key id must be its own: a signature by key a claiming key b's id fails, not passes.
    await expect(refuse("v1.2.3", SUMS_TEXT, `${testKey("b").id} ${good.split(" ")[1]}`)).rejects.toThrow("doesn't verify");
  });

  test("the compiled-in list is the default, and it doesn't hold a test key", async () => {
    await expect(verifySums("v1.2.3", enc(SUMS_TEXT), sign(SUMS_TEXT))).rejects.toThrow("unknown key id");
  });
});

describe("derToP1363", () => {
  const int = (bytes: number[]) => [0x02, bytes.length, ...bytes];
  const seq = (...ints: number[][]) => {
    const body = ints.flat();
    return Uint8Array.from([0x30, body.length, ...body]);
  };
  const r32 = Array.from({ length: 32 }, (_, i) => i + 1);

  test("a 33-byte 0x00-padded integer and a short one are left-padded to 32", () => {
    const high = [0x80, ...r32.slice(1)];
    const out = derToP1363(seq(int([0, ...high]), int([5])));
    expect([...out.subarray(0, 32)]).toEqual(high);
    expect([...out.subarray(32)]).toEqual([...Array(31).fill(0), 5]);
  });

  test("malformed DER refuses", () => {
    const bad: [string, Uint8Array][] = [
      ["a P1363 signature where DER is expected", Uint8Array.from(Array(64).fill(1))],
      ["a wrong outer length", Uint8Array.from([...seq(int(r32), int(r32)).subarray(0, 1), 0x10, ...seq(int(r32), int(r32)).subarray(2)])],
      ["trailing bytes", Uint8Array.from([0x30, 0x47, ...int(r32), ...int(r32), 0x00, 0x00, 0x00])],
      ["a non-minimal integer", seq(int([0, 0x01, ...r32.slice(1)]), int(r32))],
      ["a negative integer", seq(int([0x80, ...r32.slice(1)]), int(r32))],
      ["an integer longer than 33 bytes", seq(int([0, 0, ...r32]), int(r32))],
      ["a missing s", seq(int(r32))],
    ];
    for (const [what, der] of bad) expect(() => derToP1363(der), what).toThrow();
  });
});

describe("parseSums", () => {
  test("refuses a missing tag line, malformed lines and duplicates", () => {
    expect(() => parseSums(`${HEX}  x\n`)).toThrow("# grayboard <tag>");
    expect(() => parseSums(`# grayboard v1.0.0\n${HEX} x\n`)).toThrow("malformed line");
    expect(() => parseSums(`# grayboard v1.0.0\n${HEX}  x y\n`)).toThrow("malformed line");
    expect(() => parseSums(`# grayboard v1.0.0\n${HEX}  x\n${HEX}  x\n`)).toThrow("lists x twice");
  });

  test("the tag must be a release tag's shape: it goes into URLs and file names", () => {
    expect(parseSums(`# grayboard v1.3.0-rc.1\n${HEX}  x\n`).tag).toBe("v1.3.0-rc.1");
    for (const tag of ["v1", "1.0.0", "v1.0.0/../../tmp/x", "v1.0.0-", "v1.0.0-a/b"]) {
      expect(() => parseSums(`# grayboard ${tag}\n${HEX}  x\n`), tag).toThrow('has no "# grayboard <tag>" first line');
    }
  });
});

// assets/release-keys/*.pem is the list; release_keys.ts and install.sh embed it.
test("the key list: assets/release-keys = release_keys.ts = install.sh", () => {
  const keys = canonicalKeys();
  expect(RELEASE_KEYS).toEqual(keys);
  for (const [id, pem] of Object.entries(keys)) expect(keyId(pem)).toBe(id);
  expect(readFileSync(join(ROOT, "src", "shared", "release_keys.ts"), "utf8")).toBe(renderTs(keys));
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  expect(sh).toBe(spliceSh(sh, keys));
  for (const t of ["a", "b", "c"]) expect(sh).not.toContain(testKey(t).id);
});
