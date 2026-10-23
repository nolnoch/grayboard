// File attachments on direct messages and posts: limits, type detection, and
// the checks a session's MCP process runs on the paths an agent names before
// any byte leaves its host. Storage is src/core/attachments.ts.
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { link, mkdir, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { CoreError, TooLargeError } from "../core/errors.ts";

export const MAX_ATTACHMENTS = 5;
// Size caps per file and per message or post. A server sets its own
// (src/server/config.ts) and tells clients in hello_ok; local mode uses these.
export type AttachmentLimits = { file: number; total: number };
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = { file: 10 * 1024 * 1024, total: 25 * 1024 * 1024 };
// An upload no message or post claimed within this long is dropped.
export const UNBOUND_TTL_MS = 3_600_000;
// How many bytes of unsent uploads one user may hold on a server at a time.
export const unboundCap = (limits: AttachmentLimits): number => 2 * limits.total;
// How many bytes of attachments, sent or not, one user may store on a server.
export const DEFAULT_ATTACHMENT_USER_QUOTA = 1024 * 1024 * 1024;

// What reads and pushes show for each attachment. sha256 is of the bytes, so a
// reader can check what it saved and match it against the audit log.
export type AttachmentInfo = { id: number; filename: string; type: string; size: number; sha256: string };

export const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export type AttachmentFile = { filename: string; type: string; data: Uint8Array };

const MAX_FILENAME_BYTES = 200;

// A display name safe in a path, a channel meta value and a Slack title: the
// last path segment, with control characters, separators, quotes and ";" (the
// meta list separator) replaced.
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // Cut by code point, so a surrogate pair is never split.
  // \p{Cf}: bidi overrides and other invisible format characters, which can
  // make "gnp.exe" read as "exe.png".
  const chars = [...base.replace(/[\u0000-\u001f\u007f"';<>|:*?]|\p{Cf}/gu, "_").trim()];
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

// Private keys, certificates, credential stores, and cloud and cluster
// configs, by name. Dotfiles and dot directories (.env, .ssh, .aws, .netrc)
// are refused separately.
const SECRET_NAME =
  /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|credentials(\..*)?|kubeconfig(\..*)?|service[-_]?account.*\.json|authkey_.*\.p8|.*\.tfvars(\.json)?|.*\.tfstate(\.backup)?)$|\.(pem|key|p8|p12|pfx|jks|keystore|ppk|kdbx|ovpn)$/i;
// Key material in a text file, whatever its name.
const SECRET_CONTENT = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|PuTTY-User-Key-File-\d|aws_secret_access_key\s*=/;

// Extensions each type may keep; a name without one gets the first appended.
// Text keeps its own extension unless a browser or the OS would render or run
// it rather than show it as text.
const TYPE_EXTENSIONS: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};
const RENDERED_TEXT = new Set([
  ".html", ".htm", ".xhtml", ".mhtml", ".svg", ".xml", ".url", ".webloc", ".inetloc", ".desktop", ".hta", ".lnk", ".scf",
]);

// The name with an extension that matches its sniffed type, so a saved file
// or a Slack title can't pass one kind of file off as another.
export function typedName(name: string, type: string): string {
  const ext = extname(name).toLowerCase();
  const allowed = TYPE_EXTENSIONS[type];
  if (allowed) return allowed.includes(ext) ? name : `${name}${allowed[0]}`;
  return RENDERED_TEXT.has(ext) ? `${name}.txt` : name;
}

/**
 * The checks a file gets wherever it enters the bus: an agent's path, an HTTP
 * upload, a Slack share. A safe name, not a dotfile or credential-like name,
 * not empty, an allowed type sniffed from its bytes, no key material in text,
 * and an extension that matches the type. `label` leads each refusal.
 */
export function checkFile(label: string, rawName: string, data: Uint8Array): AttachmentFile {
  const name = sanitizeFilename(rawName);
  if (name.startsWith(".")) throw new CoreError(`${label}: dotfiles aren't attachable`);
  if (SECRET_NAME.test(name)) throw new CoreError(`${label}: looks like a key or credentials file; not attachable`);
  if (data.length === 0) throw new CoreError(`${label}: empty file`);
  const type = sniffType(data, name);
  if (!type) throw new CoreError(`${label}: not an image (PNG, JPEG, GIF, WebP), a PDF, or UTF-8 text`);
  if (!TYPE_EXTENSIONS[type] && SECRET_CONTENT.test(new TextDecoder().decode(data))) {
    throw new CoreError(`${label}: holds private key or secret key material; not attachable`);
  }
  return { filename: typedName(name, type), type, data };
}

/** The per-file and per-message caps, checked as files are added, worded the same everywhere. */
export class SizeTally {
  private total = 0;

  constructor(private readonly limits: AttachmentLimits, count: number) {
    if (count > MAX_ATTACHMENTS) throw new CoreError(`at most ${MAX_ATTACHMENTS} attachments per message`);
  }

  add(label: string, size: number): void {
    if (size > this.limits.file) throw new TooLargeError(`${label}: ${formatSize(size)} exceeds the ${formatSize(this.limits.file)} limit per file`);
    this.total += size;
    if (this.total > this.limits.total) throw new TooLargeError(`attachments exceed ${formatSize(this.limits.total)} in all`);
  }
}

// Where an agent may attach files from: the session's working directory and
// BUS_ATTACH_ROOTS (a path list, the declared scratch directories). A working
// directory that is the home directory or a filesystem root doesn't count:
// it would let an agent attach almost anything. Resolved, since a file's own
// path is compared after symlinks are resolved.
export function attachRoots(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string[] {
  const out = new Set<string>();
  const add = (r: string) => {
    try {
      out.add(realpathSync(resolve(cwd, r)));
    } catch {
      // A root that doesn't exist holds no files.
    }
  };
  add(cwd);
  for (const broad of [homedir(), parse(resolve(cwd)).root]) {
    try {
      out.delete(realpathSync(broad));
    } catch {
      // Nothing to drop.
    }
  }
  for (const r of (env.BUS_ATTACH_ROOTS ?? "").split(delimiter).filter(Boolean)) add(r);
  return [...out];
}

const ROOTS_HINT = "its working directory unless that's the home directory, and BUS_ATTACH_ROOTS";

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
  if (!rel) throw new CoreError(`dir ${dir} is outside the directories this session may write to (${ROOTS_HINT})`);
  if (rel.some((c) => c.startsWith("."))) throw new CoreError(`dir ${dir}: saving into dot directories isn't allowed`);
  return real;
}

// Reads and checks the files an agent named, all of them before any is
// stored. Each must resolve (symlinks followed) under a root with no dot
// component below it, pass checkFile, and fit the limits (the server's, in
// server mode). Each file is opened once, without following a symlink swapped
// in after the check, and read no further than its checked size.
export async function readAttachmentFiles(
  paths: unknown,
  roots: string[],
  opts: { cwd?: string; limits?: AttachmentLimits } = {},
): Promise<AttachmentFile[]> {
  const cwd = opts.cwd ?? process.cwd();
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p)) {
    throw new CoreError("attachments must be a list of file paths");
  }
  const tally = new SizeTally(opts.limits ?? DEFAULT_ATTACHMENT_LIMITS, paths.length);
  const out: AttachmentFile[] = [];
  for (const p of paths as string[]) {
    const label = `attachment ${p}`;
    let real: string;
    try {
      real = realpathSync(resolve(cwd, p));
    } catch {
      throw new CoreError(`${label}: no such file`);
    }
    const rel = under(real, roots);
    if (!rel) throw new CoreError(`${label}: outside the directories this session may attach from (${ROOTS_HINT})`);
    if (rel.some((c) => c.startsWith("."))) throw new CoreError(`${label}: dotfiles and files in dot directories aren't attachable`);
    // The real name is checked too, so a link named notes.txt can't carry id_rsa.
    if (SECRET_NAME.test(basename(real))) throw new CoreError(`${label}: looks like a key or credentials file; not attachable`);
    const data = await readChecked(real, label, tally);
    out.push(checkFile(label, p.split(/[\\/]/).pop() ?? basename(real), data));
  }
  return out;
}

async function readChecked(real: string, label: string, tally: SizeTally): Promise<Uint8Array> {
  let fh: FileHandle;
  try {
    // O_NONBLOCK: a FIFO opens at once and fails the regular-file check below.
    fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    throw new CoreError(`${label}: can't be opened (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new CoreError(`${label}: not a regular file`);
    if (st.size === 0) throw new CoreError(`${label}: empty file`);
    tally.add(label, st.size);
    // One byte past the checked size, to notice a file that grew.
    const buf = new Uint8Array(st.size + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n !== st.size) throw new CoreError(`${label}: changed while being read`);
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

// The channel meta value for a message's or post's attachments:
// "12:shot.png image/png 340KB sha256:<hex>; 13:notes.md text/markdown 2KB sha256:<hex>".
export function formatAttachmentsMeta(list: AttachmentInfo[]): string {
  return list.map((a) => `${a.id}:${a.filename} ${a.type} ${formatSize(a.size)} sha256:${a.sha256}`).join("; ");
}

// The attachment ids in such a meta value, in order. Throws on any item that
// isn't in formatAttachmentsMeta's shape, so a change to one without the other
// fails loudly instead of dropping files. Filenames can't hold ";" or ":"
// (sanitizeFilename), so the split is exact.
export function parseAttachmentsMeta(meta: string | undefined): number[] {
  if (!meta) return [];
  return meta.split("; ").map((item) => {
    const m = /^(\d+):.+ \S+\/\S+ \d+(?:\.\d)?(?:B|KB|MB) sha256:[0-9a-f]{64}$/.exec(item);
    if (!m) throw new Error(`unreadable attachments meta item: ${JSON.stringify(item)}`);
    return Number(m[1]);
  });
}

// attachment_get's id, alike in both modes.
export function checkAttachmentId(id: unknown): number {
  if (!Number.isSafeInteger(id) || (id as number) < 1) throw new CoreError("id must be an attachment id");
  return id as number;
}

// Where attachment_get saves: `dir` (checked against the roots) or the bus's
// subdirectory of the default directory. Ids are per bus, so the default
// directory is split by bus. Resolved before the bytes are fetched, so a
// refused dir costs no download.
export async function saveTarget(
  dir: unknown,
  roots: string[],
  bus: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  if (dir !== undefined && typeof dir !== "string") throw new CoreError("dir must be a string");
  if (dir !== undefined) return checkSaveDir(dir, roots);
  const target = join(attachmentsDir(env), bus);
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}

// attachment_get's write into `target` (from saveTarget), as
// <id>-<filename>, readable only by this user.
export function saveAttachment(a: AttachmentInfo, data: Uint8Array, target: string): Promise<string> {
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

// Not alwaysLoad: a channel notification with files names this tool
// (files_tool, src/core/tools.ts), and tool results list the ids.
export const ATTACHMENT_GET_TOOL = {
  name: "attachment_get",
  description:
    "attachment_get(id, dir?): save a file attached to a message or post you can read (ids are in its attachments) and return the saved path.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The attachment id." },
      dir: { type: "string", description: "Optional. Directory to save into, under your working directory or BUS_ATTACH_ROOTS. Default ~/.grayboard/attachments." },
    },
    required: ["id"],
  },
};

// The Repr-Digest (RFC 9530) a server sends an attachment with, and the hex
// sha256 a client reads back from it to check the bytes it got.
export const reprDigest = (sha256: string): string => `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

export function digestSha256(header: string | null): string | null {
  const m = /(?:^|,)\s*sha-256=:([A-Za-z0-9+/]+=*):/.exec(header ?? "");
  return m ? Buffer.from(m[1]!, "base64").toString("hex") : null;
}

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
