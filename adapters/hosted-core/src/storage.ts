// An adapter's own state under its state dir: atomic JSON files, the
// per-root KeyValueStorage, and the per-root delivery lock. OpenCode V2 uses
// its host's storage instead.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { tryAcquire, type Lock } from "./lock.js";
import type { KeyValueStorage } from "./port.js";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Undefined when the file doesn't exist; a file that isn't JSON throws.
export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as { code?: unknown }).code === "ENOENT") return undefined; throw error; }
  return JSON.parse(text);
}

// Temp file (0600, exclusive create), fsync, rename, fsync the directory
// (0700): a reader sees the old file or the new one, never a torn write, and
// the rename survives a crash. Windows has no directory fsync; NTFS journals
// the rename.
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// One root's files are keyed by the resource, the client id and the
// harness's raw root id, so two servers, two client ids or two roots in one
// state dir never collide.
export const rootKey = (resource: string, clientId: string, rawRootId: string) => sha256(`${resource}\n${clientId}\n${rawRootId}`);
export const sessionPath = (stateDir: string, resource: string, clientId: string, rawRootId: string) => join(stateDir, "sessions", `${rootKey(resource, clientId, rawRootId)}.json`);
export const deliveryPath = (stateDir: string, resource: string, clientId: string, rawRootId: string) => join(stateDir, "delivery", `${rootKey(resource, clientId, rawRootId)}.lock`);

// A root's session state file: one JSON object of storage keys.
const SessionState = z.record(z.string(), z.unknown());

// The Controller's KeyValueStorage for one root: one JSON object per file.
// Only that root's delivery-lock holder writes it; writes in this process
// are serialized so a read-modify-write never loses a key.
export class FileStorage implements KeyValueStorage {
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  async get(key: string): Promise<unknown> {
    await this.writes.catch(() => {});
    return (await this.read())[key];
  }
  set(key: string, value: unknown): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      const next = await this.read();
      if (value === undefined) delete next[key]; else next[key] = value;
      await writeJsonAtomic(this.path, next);
    });
    this.writes = write;
    return write;
  }
  private async read(): Promise<Record<string, unknown>> {
    const raw = await readJson(this.path);
    return raw === undefined ? {} : SessionState.parse(raw);
  }
}

// The root's delivery lock, held while a Controller runs that root: two
// processes on one raw id would otherwise share one lease (delivery_open
// returns the live capability for the same session and ownership) and both
// admit every item. Undefined when another process holds it; that process
// runs tools-only (DeliveryHeldElsewhere) and waits with waitDelivery.
export function tryDelivery(path: string): Lock | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return tryAcquire(path);
}
// Retries tryDelivery every `intervalMs` (5 s) until it wins; rejects when
// `signal` aborts.
export async function waitDelivery(path: string, signal: AbortSignal, intervalMs = 5_000): Promise<Lock> {
  for (;;) {
    signal.throwIfAborted();
    const lock = tryDelivery(path);
    if (lock) return lock;
    await sleep(intervalMs, undefined, { signal });
  }
}
