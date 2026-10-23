// File attachments on direct messages and posts: limits, type detection, and
// the checks a session's MCP process runs on the paths an agent names before
// any byte leaves its host. Storage is src/core/attachments.ts.
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { link, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CoreError } from "../core/boards.ts";

export const MAX_ATTACHMENTS = 5;
// Size caps per file and per message or post. A server sets its own
// (src/server/config.ts) and tells clients in hello_ok; local mode uses these.
export type AttachmentLimits = { file: number; total: number };
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = { file: 10 * 1024 * 1024, total: 25 * 1024 * 1024 };
// An upload no message or post claimed within this long is dropped.
export const UNBOUND_TTL_MS = 3_600_000;
// How many bytes of unsent uploads one user may hold on a server at a time.
export const unboundCap = (limits: AttachmentLimits): number => 2 * limits.total;

// What reads and pushes show for each attachment.
export type AttachmentInfo = { id: number; filename: string; type: string; size: number };

export type AttachmentFile = { filename: string; type: string; data: Uint8Array };

const MAX_FILENAME_BYTES = 200;

// A display name safe in a path, a channel meta value and a Slack title: the
// last path segment, with control characters, separators, quotes and ";" (the
// meta list separator) replaced.
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // Cut by code point, so a surrogate pair is never split.
  const chars = [...base.replace(/[\u0000-\u001f\u007f"';<>|:*?]/g, "_").trim()];
  while (new TextEncoder().encode(chars.join("")).length > MAX_FILENAME_BYTES) chars.pop();
  const out = chars.join("");
  if (!out || out === "." || out === "..") return "file";
  return out;
}

const TEXT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

const startsWith = (d: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => d[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// The media type, from the bytes rather than the name: PNG, JPEG, GIF, WebP,
// PDF, or UTF-8 text without NUL (typed by extension). Null for anything else.
export function sniffType(data: Uint8Array, filename: string): string | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(data, ascii("GIF87a")) || startsWith(data, ascii("GIF89a"))) return "image/gif";
  if (startsWith(data, ascii("RIFF")) && startsWith(data, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(data, ascii("%PDF-"))) return "application/pdf";
  if (data.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
  return TEXT_TYPES[extname(filename).toLowerCase()] ?? "text/plain";
}

// Private keys, certificates and credential stores, by name. Dotfiles and
// dot directories (.env, .ssh, .aws, .netrc) are refused separately.
const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|credentials(\..*)?)$|\.(pem|key|p12|pfx|jks|keystore)$/i;

// Where an agent may attach files from: the session's working directory, the
// OS temp directories, and BUS_ATTACH_ROOTS (a path list). Resolved, since a
// file's own path is compared after symlinks are resolved.
export function attachRoots(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string[] {
  const roots = [cwd, tmpdir(), "/tmp", ...(env.BUS_ATTACH_ROOTS ?? "").split(delimiter).filter(Boolean)];
  const out = new Set<string>();
  for (const r of roots) {
    try {
      out.add(realpathSync(resolve(cwd, r)));
    } catch {
      // A root that doesn't exist holds no files.
    }
  }
  return [...out];
}

// The root `real` lies under and its path below that root, or null.
function under(real: string, roots: string[]): string[] | null {
  for (const root of roots) {
    const rel = relative(root, real);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep);
  }
  return null;
}

// A directory attachment_get may write into: a root, or under one with no dot
// component below it (as for reads), so a save can't plant files where tools
// load them from (.claude/rules, .github/workflows, .git/hooks).
export function checkSaveDir(dir: string, roots: string[], cwd = process.cwd()): string {
  let real: string;
  try {
    real = realpathSync(resolve(cwd, dir));
  } catch {
    throw new CoreError(`dir ${dir} doesn't exist`);
  }
  if (roots.includes(real)) return real;
  const rel = under(real, roots);
  if (!rel) {
    throw new CoreError(`dir ${dir} is outside the directories this session may write to (its working directory, the temp directory, BUS_ATTACH_ROOTS)`);
  }
  if (rel.some((c) => c.startsWith("."))) throw new CoreError(`dir ${dir}: saving into dot directories isn't allowed`);
  return real;
}

// Reads and checks the files an agent named, all of them before any is
// stored. Each must resolve (symlinks followed) under a root, with no dot
// component below it and no credential-like name; be at most maxBytes; and
// be an image, a PDF, or UTF-8 text. At most MAX_ATTACHMENTS files, and
// within the limits (the server's, in server mode).
export async function readAttachmentFiles(
  paths: unknown,
  roots: string[],
  opts: { cwd?: string; limits?: AttachmentLimits } = {},
): Promise<AttachmentFile[]> {
  const cwd = opts.cwd ?? process.cwd();
  const { file: maxBytes, total: maxTotal } = opts.limits ?? DEFAULT_ATTACHMENT_LIMITS;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p)) {
    throw new CoreError("attachments must be a list of file paths");
  }
  if (paths.length > MAX_ATTACHMENTS) throw new CoreError(`at most ${MAX_ATTACHMENTS} attachments per message`);
  const out: AttachmentFile[] = [];
  let total = 0;
  for (const p of paths as string[]) {
    let real: string;
    try {
      real = realpathSync(resolve(cwd, p));
    } catch {
      throw new CoreError(`attachment ${p}: no such file`);
    }
    const rel = under(real, roots);
    if (!rel) {
      throw new CoreError(`attachment ${p}: outside the directories this session may attach from (its working directory, the temp directory, BUS_ATTACH_ROOTS)`);
    }
    if (rel.some((c) => c.startsWith("."))) throw new CoreError(`attachment ${p}: dotfiles and files in dot directories aren't attachable`);
    const name = basename(real);
    if (SECRET_NAME.test(name)) throw new CoreError(`attachment ${p}: looks like a key or credentials file; not attachable`);
    const st = await stat(real);
    if (!st.isFile()) throw new CoreError(`attachment ${p}: not a regular file`);
    if (st.size === 0) throw new CoreError(`attachment ${p}: empty file`);
    if (st.size > maxBytes) throw new CoreError(`attachment ${p}: ${formatSize(st.size)} exceeds the ${formatSize(maxBytes)} limit`);
    total += st.size;
    if (total > maxTotal) throw new CoreError(`attachments exceed ${formatSize(maxTotal)} in all`);
    const data = new Uint8Array(await readFile(real));
    // Re-checked on the bytes read, in case the file grew after stat.
    if (data.length > maxBytes) throw new CoreError(`attachment ${p}: exceeds the ${formatSize(maxBytes)} limit`);
    const filename = sanitizeFilename(p.split(/[\\/]/).pop() ?? name);
    const type = sniffType(data, filename);
    if (!type) throw new CoreError(`attachment ${p}: not an image (PNG, JPEG, GIF, WebP), a PDF, or UTF-8 text`);
    out.push({ filename, type, data });
  }
  return out;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

// The channel meta value for a message's or post's attachments:
// "12:shot.png image/png 340KB; 13:notes.md text/markdown 2KB".
export function formatAttachmentsMeta(list: AttachmentInfo[]): string {
  return list.map((a) => `${a.id}:${a.filename} ${a.type} ${formatSize(a.size)}`).join("; ");
}

// The attachment ids in such a meta value, in order.
export function parseAttachmentsMeta(meta: string | undefined): number[] {
  if (!meta) return [];
  return meta
    .split("; ")
    .map((item) => /^(\d+):/.exec(item)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number);
}

// attachment_get's write: into `dir` (checked against the roots) or the bus's
// subdirectory of the default directory, as <id>-<filename>, readable only by
// this user. Ids are per bus, so the default directory is split by bus.
export async function saveAttachment(
  a: AttachmentInfo,
  data: Uint8Array,
  dir: unknown,
  roots: string[],
  bus: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (dir !== undefined && typeof dir !== "string") throw new CoreError("dir must be a string");
  let target: string;
  if (dir === undefined) {
    target = join(attachmentsDir(env), bus);
    await mkdir(target, { recursive: true, mode: 0o700 });
  } else {
    target = checkSaveDir(dir, roots);
  }
  return writeNew(target, `${a.id}-${sanitizeFilename(a.filename)}`, data);
}

const MAX_NAME_TRIES = 100;

// Writes data into dir as name, or name-2, name-3… when that's taken by
// anything but this user's own copy of the same bytes. The bytes go to a
// private temp file first, then a hard link puts them in place: link never
// follows or replaces what's at the name, so a symlink or file another user
// planted in a shared directory (/tmp) is skipped, and no reader sees a
// partial file.
async function writeNew(dir: string, name: string, data: Uint8Array): Promise<string> {
  const tmp = join(dir, `.grayboard-${randomUUID()}.tmp`);
  await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n <= MAX_NAME_TRIES; n++) {
      const path = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
      try {
        await link(tmp, path);
        return path;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      if (await isOwnCopy(path, data)) return path;
    }
    throw new CoreError(`can't save ${name} in ${dir}: ${MAX_NAME_TRIES} files by that name already exist`);
  } finally {
    await rm(tmp, { force: true });
  }
}

// Whether path is a regular file (not a symlink) this user owns holding
// exactly data: an earlier save of the same attachment.
async function isOwnCopy(path: string, data: Uint8Array): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || st.size !== data.length) return false;
    return Buffer.from(await fh.readFile()).equals(data);
  } finally {
    await fh.close();
  }
}

// The default save directory's subdirectory for a bus: the server's host, or
// a hash of the local database's path.
export const serverBusDir = (serverUrl: string): string => new URL(serverUrl).host.replace(/[^A-Za-z0-9.-]/g, "_");
export const localBusDir = (dbPath: string): string => `local-${createHash("sha256").update(resolve(dbPath)).digest("hex").slice(0, 12)}`;

// dm_send's and board_post's attachments parameter, the same in both modes.
export const ATTACHMENTS_PARAM = {
  type: "array",
  items: { type: "string" },
  description: `Optional. Paths of files to send: images (PNG, JPEG, GIF, WebP), PDF or UTF-8 text; up to ${MAX_ATTACHMENTS}. Readers get them with attachment_get.`,
};

// Not alwaysLoad: a message or post with files names its attachment ids.
export const ATTACHMENT_GET_TOOL = {
  name: "attachment_get",
  description:
    "attachment_get(id, dir?): save a file attached to a message or post you can read (ids are in its attachments) and return the saved path.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The attachment id." },
      dir: { type: "string", description: "Optional. Directory to save into, under your working directory or the temp directory. Default ~/.grayboard/attachments." },
    },
    required: ["id"],
  },
};

// The Content-Disposition a server sends an attachment with, and the filename
// a client reads back from it (sanitizeFilename's output, so no quotes).
export function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function dispositionFilename(header: string | null): string | null {
  const m = /filename\*=UTF-8''([^;]+)/.exec(header ?? "");
  if (!m) return null;
  try {
    return sanitizeFilename(decodeURIComponent(m[1]!));
  } catch {
    return null;
  }
}

// Where attachment_get saves by default.
export function attachmentsDir(env: Record<string, string | undefined> = process.env): string {
  return env.GRAYBOARD_ATTACHMENTS_DIR ?? join(homedir(), ".grayboard", "attachments");
}
