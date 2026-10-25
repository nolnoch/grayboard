// The server's BlobStore: attachment bytes as files under one directory,
// <dir>/<first two hex digits>/<sha256>. A put writes a temp file in <dir>/tmp,
// syncs it and renames it into place, so a reader sees all of the bytes or
// none. Only this process writes here (src/core/attachments.ts serializes
// uploads and sweeps per sha256 in-process).
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { BlobStore } from "../core/attachments.ts";
import { BlobMissing } from "../core/errors.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export class DiskBlobs implements BlobStore {
  // Temp files a crash left behind are dropped: no put is running yet.
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(join(dir, "tmp"), { recursive: true, force: true });
  }

  private path(sha256: string): string {
    // The key becomes a path: anything but a hex digest is a bug upstream.
    if (!SHA256.test(sha256)) throw new Error(`not a sha256: ${JSON.stringify(sha256.slice(0, 80))}`);
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  async put(sha256: string, data: Uint8Array): Promise<void> {
    const path = this.path(sha256);
    const tmpDir = join(this.dir, "tmp");
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.dir, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    const tmp = join(tmpDir, `${sha256}.${randomUUID()}`);
    try {
      const f = await open(tmp, "wx", 0o600);
      try {
        await f.writeFile(data);
        await f.sync();
      } finally {
        await f.close();
      }
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await syncDir(join(this.dir, sha256.slice(0, 2)));
  }

  async get(sha256: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.path(sha256)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new BlobMissing(sha256);
      throw e;
    }
  }

  async delete(sha256: string): Promise<void> {
    try {
      await unlink(this.path(sha256));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

// Makes a rename in `dir` durable.
async function syncDir(dir: string): Promise<void> {
  const d = await open(dir, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
