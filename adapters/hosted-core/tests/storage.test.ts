// #430 adapter storage: atomic 0600 files in 0700 dirs, the per-root
// KeyValueStorage, and the per-root delivery lock.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deliveryPath, FileRefused, FileStorage, readSmallJson, rootKey, sessionPath, tryDelivery, waitDelivery, writeJsonAtomic } from "../src/storage.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gb-storage-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const RESOURCE = "https://grayboard.example.com/mcp";

test("root files are keyed by resource, client id and raw root id", () => {
  const a = sessionPath(dir, RESOURCE, "grayboard-pi", "root-1");
  expect(a).toBe(join(dir, "sessions", `${rootKey(RESOURCE, "grayboard-pi", "root-1")}.json`));
  expect(new Set([a, sessionPath(dir, RESOURCE, "grayboard-omp", "root-1"), sessionPath(dir, "https://other.example.com/mcp", "grayboard-pi", "root-1"), sessionPath(dir, RESOURCE, "grayboard-pi", "root-2")]).size).toBe(4);
  expect(deliveryPath(dir, RESOURCE, "grayboard-pi", "root-1")).toBe(join(dir, "delivery", `${rootKey(RESOURCE, "grayboard-pi", "root-1")}.lock`));
});

test("an atomic write leaves a 0600 file in a 0700 directory and no temp file", async () => {
  const path = join(dir, "grants", "store.json");
  await writeJsonAtomic(path, { a: 1 });
  await writeJsonAtomic(path, { a: 2 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  expect(readdirSync(dirname(path))).toEqual(["store.json"]);
  expect(JSON.parse(await Bun.file(path).text())).toEqual({ a: 2 });
});

test("FileStorage keeps every key across concurrent sets, deletes on undefined, and refuses a non-object file", async () => {
  const storage = new FileStorage(sessionPath(dir, RESOURCE, "grayboard-pi", "root"));
  expect(await storage.get("missing")).toBeUndefined();
  await Promise.all([storage.set("paused:root", true), storage.set("rememberedName:root", "be"), storage.set("diagnostics:v1", [{ state: "active" }])]);
  const reread = new FileStorage(storage.path);
  expect(await reread.get("paused:root")).toBe(true);
  expect(await reread.get("rememberedName:root")).toBe("be");
  expect(await reread.get("diagnostics:v1")).toEqual([{ state: "active" }]);
  await reread.set("paused:root", undefined);
  expect(await new FileStorage(storage.path).get("paused:root")).toBeUndefined();
  writeFileSync(storage.path, "[1]");
  await expect(reread.get("rememberedName:root")).rejects.toThrow();
});

test("the delivery lock admits one holder; a waiter wins once it is released and stops on abort", async () => {
  const path = deliveryPath(dir, RESOURCE, "grayboard-pi", "root");
  const held = tryDelivery(path)!;
  expect(held).toBeDefined();
  expect(tryDelivery(path)).toBeUndefined();
  const abort = new AbortController();
  const stopped = waitDelivery(path, abort.signal, 20);
  abort.abort();
  await expect(stopped).rejects.toThrow();
  const waiting = waitDelivery(path, new AbortController().signal, 20);
  held.release();
  const won = await waiting;
  expect(tryDelivery(path)).toBeUndefined();
  won.release();
});

test("readSmallJson: a missing file is undefined; a FIFO, a directory, a symbolic link and a file over the cap are refused without blocking; a small file parses (#592, #596)", async () => {
  const at = (name: string) => join(dir, name);
  expect(await readSmallJson(at("missing"), 64)).toBeUndefined();
  writeFileSync(at("small"), JSON.stringify({ url: "u" }));
  expect(await readSmallJson(at("small"), 64)).toEqual({ url: "u" });
  writeFileSync(at("big"), JSON.stringify({ url: "u".repeat(64) }));
  await expect(readSmallJson(at("big"), 64)).rejects.toThrow(new FileRefused("is over 64 bytes"));
  mkdirSync(at("dir"));
  await expect(readSmallJson(at("dir"), 64)).rejects.toThrow(new FileRefused("isn't a regular file"));
  writeFileSync(at("text"), "{not json");
  await expect(readSmallJson(at("text"), 64)).rejects.toBeInstanceOf(SyntaxError);
  if (process.platform === "win32") return;
  // No writer ever opens it: a blocking open would hang here.
  expect(Bun.spawnSync(["mkfifo", at("fifo")]).exitCode).toBe(0);
  await expect(readSmallJson(at("fifo"), 64)).rejects.toThrow(new FileRefused("isn't a regular file"));  // A link is refused unopened, even to a regular file (#596).
  symlinkSync(at("small"), at("link"));
  await expect(readSmallJson(at("link"), 64)).rejects.toThrow(new FileRefused("is a symbolic link"));
});
