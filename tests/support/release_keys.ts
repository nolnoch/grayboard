// Test release signing (#162): P-256 keys made by the openssl CLI, and
// SHA256SUMS(.sig) signed by `openssl dgst -sha256 -sign`, the way release.yml
// signs, so the verifiers are tested against openssl's DER and not a
// signature they produced themselves. Keys are made once per process and never
// written into the tree.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spliceSh } from "../../scripts/release_keys.ts";
import { keyId } from "../../src/shared/release_verify.ts";
import { ROOT } from "./paths.ts";

export type TestKey = { id: string; pem: string; priv: string };

const dir = mkdtempSync(join(tmpdir(), "grayboard-release-keys-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const made = new Map<string, TestKey>();

function openssl(args: string[], stdin?: Uint8Array | string): Buffer {
  const p = Bun.spawnSync(["openssl", ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`openssl ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout;
}

/** The test key named `name` ("a", "b": the builds' list; "c": a key nobody lists). */
export function testKey(name = "a"): TestKey {
  let k = made.get(name);
  if (!k) {
    const priv = join(dir, `${name}.key`);
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", priv]);
    const pem = openssl(["pkey", "-in", priv, "-pubout"]).toString();
    k = { id: keyId(pem), pem, priv };
    made.set(name, k);
  }
  return k;
}

/** The list the test builds and the test install.sh carry: keys a and b. */
export function testKeys(): Record<string, string> {
  return Object.fromEntries(["a", "b"].map((n) => [testKey(n).id, testKey(n).pem]));
}

/** `text`'s SHA256SUMS.sig line under `key`, as release.yml writes it. */
export function sign(text: string, key = testKey()): string {
  const der = openssl(["dgst", "-sha256", "-sign", key.priv], text);
  return `${key.id} ${der.toString("base64")}\n`;
}

/** A release's SHA256SUMS for `tag` over `files` (asset name → path), as release.yml writes it. */
export function sumsFor(tag: string, files: Record<string, string>): string {
  const lines = Object.entries(files)
    .map(([name, path]) => `${new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")}  ${name}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  return [`# grayboard ${tag}`, ...lines].join("\n") + "\n";
}

/** SHA256SUMS and its .sig for `tag` over `files`. */
export function signSums(tag: string, files: Record<string, string>, key = testKey()): { sums: string; sig: string } {
  const sums = sumsFor(tag, files);
  return { sums, sig: sign(sums, key) };
}

/** A copy of install.sh in `into` whose key block lists `keys` (default: the test list); returns its path. */
export function testInstallSh(into: string, keys: Record<string, string> = testKeys()): string {
  const p = join(into, "install.sh");
  writeFileSync(p, spliceSh(readFileSync(join(ROOT, "install.sh"), "utf8"), keys));
  return p;
}
