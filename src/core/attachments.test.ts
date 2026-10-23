import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentIds,
  bindAttachments,
  canReadAttachment,
  dropAttachments,
  getAttachment,
  pruneUnbound,
  releaseUpload,
  storeAttachment,
  sweepBlobs,
  withAttachments,
  type BlobStore,
} from "./attachments.ts";
import { SqliteBlobs } from "../local/blobs.ts";
import { TooLargeError, createBoard, pendingFor, post, prunePosts, read, subscribe } from "./boards.ts";
import { boardNotification, callBoardTool } from "./tools.ts";
import { initCoreSchema } from "./schema.ts";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  UNBOUND_TTL_MS,
  attachRoots,
  checkSaveDir,
  formatAttachmentsMeta,
  localBusDir,
  parseAttachmentsMeta,
  readAttachmentFiles,
  SizeTally,
  checkFile,
  digestSha256,
  reprDigest,
  sanitizeFilename,
  saveAttachment,
  serverBusDir,
  sha256Hex,
  sniffType,
  typedName,
  type AttachmentFile,
} from "../shared/attachments.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file = (data: Uint8Array | string, filename = "f.txt", type = "text/plain"): AttachmentFile => ({
  filename,
  type,
  data: typeof data === "string" ? new TextEncoder().encode(data) : data,
});
const blobCount = (db: Database) => (db.prepare(`SELECT COUNT(*) AS n FROM attachment_blobs`).get() as { n: number }).n;
const byteCount = (db: Database) => (db.prepare(`SELECT COUNT(*) AS n FROM attachment_bytes`).get() as { n: number }).n;
const LIMITS = DEFAULT_ATTACHMENT_LIMITS;

describe("type detection and names", () => {
  test("sniffType goes by the bytes; text is typed by extension", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(sniffType(PNG, "x.txt")).toBe("image/png");
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "x")).toBe("image/jpeg");
    expect(sniffType(bytes("GIF89a..."), "x")).toBe("image/gif");
    expect(sniffType(bytes("RIFF\0\0\0\0WEBPVP8 "), "x")).toBe("image/webp");
    expect(sniffType(bytes("%PDF-1.7\n"), "x")).toBe("application/pdf");
    expect(sniffType(bytes("# hi"), "notes.md")).toBe("text/markdown");
    expect(sniffType(bytes("{}"), "a.JSON")).toBe("application/json");
    expect(sniffType(bytes("a,b"), "t.csv")).toBe("text/csv");
    expect(sniffType(bytes("héllo"), "log")).toBe("text/plain");
    expect(sniffType(bytes("a\0b"), "x.txt")).toBeNull();
    expect(sniffType(new Uint8Array([0xc3, 0x28]), "x.txt")).toBeNull();
    expect(sniffType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]), "a.out")).toBeNull();
  });

  test("sanitizeFilename keeps a safe last segment", () => {
    expect(sanitizeFilename("/a/b/shot.png")).toBe("shot.png");
    expect(sanitizeFilename("..\\..\\evil.txt")).toBe("evil.txt");
    expect(sanitizeFilename('a;b"c\n.txt')).toBe("a_b_c_.txt");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
    expect(new TextEncoder().encode(sanitizeFilename("é".repeat(300))).length).toBeLessThanOrEqual(200);
    // The cut lands mid-emoji: the pair is dropped whole, never split.
    const cut = sanitizeFilename("a" + "😀".repeat(60));
    expect(cut).toBe("a" + "😀".repeat(49));
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  test("sanitizeFilename replaces bidi overrides and other format characters", () => {
    expect(sanitizeFilename("shot\u202Egnp.exe")).toBe("shot_gnp.exe");
    expect(sanitizeFilename("a\u200Bb.txt")).toBe("a_b.txt");
  });

  test("checkFile refuses dotfiles, key names, empty files, unknown types and key material", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(() => checkFile("f", ".env", bytes("A=1"))).toThrow("f: dotfiles");
    for (const name of ["id_ecdsa_sk", "kubeconfig", "service-account-prod.json", "AuthKey_ABC.p8", "prod.tfvars", "terraform.tfstate.backup", "vault.kdbx", "me.ovpn"]) {
      expect(() => checkFile("f", name, bytes("x"))).toThrow("key or credentials");
    }
    expect(() => checkFile("f", "a.txt", new Uint8Array())).toThrow("empty file");
    expect(() => checkFile("f", "a.bin", new Uint8Array([0, 1]))).toThrow("not an image");
    expect(() => checkFile("f", "notes.txt", bytes("x\n-----BEGIN OPENSSH PRIVATE KEY-----\n"))).toThrow("key material");
    expect(() => checkFile("f", "notes.txt", bytes("[default]\naws_secret_access_key = abc"))).toThrow("key material");
    // Images aren't searched for key text.
    expect(checkFile("f", "shot.png", PNG).type).toBe("image/png");
  });

  test("checkFile gives the name an extension that matches its type", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(checkFile("f", "shot", PNG).filename).toBe("shot.png");
    expect(checkFile("f", "shot.txt", PNG).filename).toBe("shot.txt.png");
    expect(checkFile("f", "photo.jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).filename).toBe("photo.jpeg");
    expect(checkFile("f", "doc", bytes("%PDF-1.7\n")).filename).toBe("doc.pdf");
    expect(checkFile("f", "page.html", bytes("<script>")).filename).toBe("page.html.txt");
    expect(checkFile("f", "icon.SVG", bytes("<svg/>")).filename).toBe("icon.SVG.txt");
    expect(checkFile("f", "go.url", bytes("[InternetShortcut]")).filename).toBe("go.url.txt");
    expect(checkFile("f", "notes.md", bytes("# hi"))).toMatchObject({ filename: "notes.md", type: "text/markdown" });
    expect(typedName("a.png", "image/png")).toBe("a.png");
  });

  test("SizeTally words each cap the same way", () => {
    const t = new SizeTally({ file: 100, total: 150 }, 2);
    expect(() => t.add("file a", 101)).toThrow("file a: 101B exceeds the 100B limit per file");
    t.add("file a", 100);
    expect(() => t.add("file b", 51)).toThrow(TooLargeError);
    expect(() => new SizeTally({ file: 1, total: 1 }, 6)).toThrow("at most 5 attachments per message");
  });

  test("Repr-Digest carries the sha256 and reads back; anything else reads as none", () => {
    const h = sha256Hex(PNG);
    expect(digestSha256(reprDigest(h))).toBe(h);
    expect(digestSha256(`sha-512=:AAAA:, ${reprDigest(h)}`)).toBe(h);
    expect(digestSha256(null)).toBeNull();
    expect(digestSha256("md5=:AAAA:")).toBeNull();
  });

  test("meta lists attachments and parses back to ids", () => {
    const meta = formatAttachmentsMeta([
      { id: 12, filename: "shot 1.png", type: "image/png", size: 340 * 1024, sha256: "a".repeat(64) },
      { id: 13, filename: "n.md", type: "text/markdown", size: 900, sha256: "b".repeat(64) },
    ]);
    expect(meta).toBe(`12:shot 1.png image/png 340KB sha256:${"a".repeat(64)}; 13:n.md text/markdown 900B sha256:${"b".repeat(64)}`);
    expect(parseAttachmentsMeta(meta)).toEqual([12, 13]);
    expect(parseAttachmentsMeta(undefined)).toEqual([]);
  });

  test("meta round-trips every size class and sanitized name, and refuses what it can't read", () => {
    const list = [0, 1023, 1024, 340 * 1024, 1024 * 1024, 1.5 * 1024 * 1024, 25 * 1024 * 1024].map((size, i) => ({
      id: 100 + i, filename: sanitizeFilename(`a b;c:${i} é.txt`), type: i % 2 ? "image/png" : "text/markdown", size, sha256: "c".repeat(64),
    }));
    expect(parseAttachmentsMeta(formatAttachmentsMeta(list))).toEqual(list.map((a) => a.id));
    expect(() => parseAttachmentsMeta("12:shot.png image/png 3B; 13 notes.md")).toThrow(/unreadable/);
    expect(() => parseAttachmentsMeta("shot.png")).toThrow(/unreadable/);
  });
});

describe("reading files to attach", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gb-attach-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "gb-attach-out-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const read1 = (p: string, roots = [root]) => readAttachmentFiles([p], roots, { cwd: root });

  test("a file under a root is read, typed and named as given", async () => {
    writeFileSync(join(root, "shot.png"), PNG);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "n.md"), "# notes");
    const files = await readAttachmentFiles(["shot.png", join(root, "docs", "n.md")], [root], { cwd: root });
    expect(files.map((f) => [f.filename, f.type, f.data.length])).toEqual([
      ["shot.png", "image/png", PNG.length],
      ["n.md", "text/markdown", 7],
    ]);
  });

  test("outside the roots, through a symlink, dot paths and key names are refused", async () => {
    writeFileSync(join(outside, "secret.txt"), "x");
    await expect(read1(join(outside, "secret.txt"))).rejects.toThrow("outside the directories");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    await expect(read1("link.txt")).rejects.toThrow("outside the directories");
    writeFileSync(join(root, ".env"), "TOKEN=x");
    await expect(read1(".env")).rejects.toThrow("dotfiles");
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "config"), "Host x");
    await expect(read1(".ssh/config")).rejects.toThrow("dot directories");
    for (const name of ["id_ed25519", "id_rsa.pub", "server.pem", "tls.key", "cert.p12", "credentials", "credentials.json"]) {
      writeFileSync(join(root, name), "x");
      await expect(read1(name)).rejects.toThrow("key or credentials");
    }
    await expect(read1("missing.txt")).rejects.toThrow("no such file");
  });

  test("a root's own dot components don't count against files under it", async () => {
    const lane = join(root, ".claude", "worktrees", "lane");
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, "a.txt"), "ok");
    expect((await readAttachmentFiles([join(lane, "a.txt")], [lane])).length).toBe(1);
  });

  test("size, count, type and emptiness limits", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(101));
    await expect(readAttachmentFiles(["big.txt"], [root], { cwd: root, limits: { file: 100, total: 1000 } })).rejects.toThrow("exceeds the 100B limit");
    writeFileSync(join(root, "bin"), new Uint8Array([0, 1, 2]));
    await expect(read1("bin")).rejects.toThrow("not an image");
    writeFileSync(join(root, "empty.txt"), "");
    await expect(read1("empty.txt")).rejects.toThrow("empty file");
    mkdirSync(join(root, "dir"));
    await expect(read1("dir")).rejects.toThrow("not a regular file");
    writeFileSync(join(root, "a.txt"), "a");
    await expect(readAttachmentFiles(Array(6).fill("a.txt"), [root], { cwd: root })).rejects.toThrow("at most 5");
    await expect(readAttachmentFiles("a.txt", [root], { cwd: root })).rejects.toThrow("list of file paths");
    const chunk = Math.ceil(DEFAULT_ATTACHMENT_LIMITS.total / 3) + 1;
    writeFileSync(join(root, "c.txt"), "x".repeat(chunk));
    await expect(readAttachmentFiles(["c.txt", "c.txt", "c.txt"], [root], { cwd: root })).rejects.toThrow("in all");
  });

  test("attachRoots is cwd and BUS_ATTACH_ROOTS, resolved; missing roots drop out", () => {
    const roots = attachRoots({ BUS_ATTACH_ROOTS: `${outside}:/no/such/dir` }, root);
    expect(roots.sort()).toEqual([root, outside].sort());
    expect(roots).not.toContain(realpathSync(tmpdir()));
  });

  test("a cwd that is the home directory or a filesystem root isn't a root", () => {
    expect(attachRoots({}, homedir())).toEqual([]);
    expect(attachRoots({}, "/")).toEqual([]);
    expect(attachRoots({ BUS_ATTACH_ROOTS: root }, homedir())).toEqual([root]);
  });

  test("a link's real name is checked too", async () => {
    writeFileSync(join(root, "id_rsa"), "x");
    symlinkSync(join(root, "id_rsa"), join(root, "notes.txt"));
    await expect(read1("notes.txt")).rejects.toThrow("key or credentials");
  });

  test("saving goes to the default directory or a dir under a root, private to the user", async () => {
    const a = { id: 7, filename: "shot.png", type: "image/png", size: PNG.length, sha256: sha256Hex(PNG) };
    const def = join(outside, "saved");
    const p1 = await saveAttachment(a, PNG, undefined, [root], "local-x", { GRAYBOARD_ATTACHMENTS_DIR: def });
    expect(p1).toBe(join(def, "local-x", "7-shot.png"));
    expect(new Uint8Array(readFileSync(p1))).toEqual(PNG);
    expect(statSync(p1).mode & 0o777).toBe(0o600);
    expect(await saveAttachment(a, PNG, root, [root], "local-x")).toBe(join(root, "7-shot.png"));
    expect(() => checkSaveDir(outside, [root])).toThrow("outside the directories");
    expect(() => checkSaveDir(join(root, "nope"), [root])).toThrow("doesn't exist");
  });

  test("saves are refused in dot directories under a root", async () => {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    const a = { id: 9, filename: "evil.md", type: "text/markdown", size: 2, sha256: sha256Hex(PNG) };
    await expect(saveAttachment(a, PNG, join(root, ".claude/rules"), [root], "b")).rejects.toThrow("dot directories");
    expect(() => checkSaveDir(join(root, ".claude"), [root], root)).toThrow("dot directories");
    expect(checkSaveDir("docs", [root], root)).toBe(join(root, "docs"));
    expect(readdirSync(join(root, ".claude", "rules"))).toEqual([]);
  });

  test("a save never follows or replaces what's at its name", async () => {
    const victim = join(outside, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(root, "8-shot.png"));
    writeFileSync(join(root, "8-shot-2.png"), "other bytes");
    const a = { id: 8, filename: "shot.png", type: "image/png", size: PNG.length, sha256: sha256Hex(PNG) };
    const p = await saveAttachment(a, PNG, root, [root], "b");
    expect(p).toBe(join(root, "8-shot-3.png"));
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(readFileSync(join(root, "8-shot-2.png"), "utf8")).toBe("other bytes");
    expect(new Uint8Array(readFileSync(p))).toEqual(PNG);
    // Saving the same attachment again finds this user's own copy.
    expect(await saveAttachment(a, PNG, root, [root], "b")).toBe(p);
    // No temp file is left behind.
    expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("each bus saves into its own default subdirectory", () => {
    expect(serverBusDir("https://bus.example.com")).toBe("bus.example.com");
    expect(serverBusDir("http://localhost:8080")).toBe("localhost_8080");
    expect(localBusDir("/a/bus.db")).toMatch(/^local-[0-9a-f]{12}$/);
    expect(localBusDir("/a/bus.db")).not.toBe(localBusDir("/b/bus.db"));
  });
});

describe("concurrent writers", () => {
  // Another process holds the write lock, then commits a row. A transaction
  // that read first would fail on its stale snapshot at its first write
  // (SQLITE_BUSY, busy_timeout or not); one that takes the lock up front waits.
  test("storing an upload waits out another process's write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-attach-busy-"));
    const path = join(dir, "bus.db");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT)`);
    initCoreSchema(db);
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(path)});
         db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
         console.log("locked");
         await Bun.sleep(300);
         db.run("INSERT INTO messages (sender, recipient) VALUES ('fe', 'be')");
         db.exec("COMMIT");`,
      ],
      { stdout: "pipe" },
    );
    await holder.stdout.getReader().read();
    try {
      expect((await storeAttachment(db, new SqliteBlobs(db), "be", file("x"))).id).toBeGreaterThan(0);
    } finally {
      await holder.exited;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage", () => {
  let db: Database;
  let blobs: SqliteBlobs;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    // Each mode brings its own messages table; this is the shape the store needs.
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT)`);
    initCoreSchema(db);
    blobs = new SqliteBlobs(db);
    createBoard(db, "be", "e2e", "fixtures");
  });
  const msg = (sender = "be", recipient = "fe") =>
    Number(db.prepare(`INSERT INTO messages (sender, recipient) VALUES (?, ?)`).run(sender, recipient).lastInsertRowid);
  const store = (uploader: string, f: AttachmentFile, opts: Parameters<typeof storeAttachment>[4] = {}) => storeAttachment(db, blobs, uploader, f, opts);
  const files = (ids: number[]) => ({ attachments: { ids, limits: LIMITS } });

  test("a quota caps the unbound bytes a user's handles hold, counted inside the store", async () => {
    const quota = { prefix: "you@example.com/", cap: 10 };
    await store("you@example.com/be", file("123456"), { quota });
    await store("other@example.com/be", file("123456"), { quota: { ...quota, prefix: "other@example.com/" } });
    await expect(store("you@example.com/fe", file("12345"), { quota })).rejects.toThrow(TooLargeError);
    expect((await store("you@example.com/fe", file("1234"), { quota })).size).toBe(4);
  });

  test("bind checks the message's total against the limits it's given", async () => {
    const ids = [(await store("be", file("x".repeat(20)))).id, (await store("be", file("y".repeat(20)))).id];
    const limits = { file: 100, total: 30 };
    expect(() => bindAttachments(db, ids, "be", { message_id: msg() }, limits)).toThrow("attachments exceed 30B in all");
    expect(bindAttachments(db, ids.slice(0, 1), "be", { message_id: msg() }, limits).length).toBe(1);
  });

  test("identical bytes share one blob; a sweep deletes it once the last attachment naming it goes", async () => {
    const a = await store("be", file("same"));
    const b = await store("fe", file("same", "other.txt"));
    expect(a.sha256).toBe(b.sha256);
    expect([blobCount(db), byteCount(db)]).toEqual([1, 1]);
    const m1 = msg();
    const m2 = msg("fe", "be");
    bindAttachments(db, [a.id], "be", { message_id: m1 }, LIMITS);
    bindAttachments(db, [b.id], "fe", { message_id: m2 }, LIMITS);
    dropAttachments(db, "message", "?", m1);
    expect(getAttachment(db, a.id)).toBeUndefined();
    expect(await sweepBlobs(db, blobs)).toBe(0);
    expect(new TextDecoder().decode(await blobs.get(a.sha256))).toBe("same");
    dropAttachments(db, "message", "?", m2);
    // Dropping deletes rows only; the bytes go in the sweep after the commit.
    expect([blobCount(db), byteCount(db)]).toEqual([1, 1]);
    expect(await sweepBlobs(db, blobs)).toBe(1);
    expect([blobCount(db), byteCount(db)]).toEqual([0, 0]);
    await expect(blobs.get(a.sha256)).rejects.toThrow("are missing");
  });

  test("releasing drops only the caller's own unsent upload, and its bytes once nothing names them", async () => {
    const mine = await store("be", file("a"));
    const bound = await store("be", file("b"));
    bindAttachments(db, [bound.id], "be", { message_id: msg() }, LIMITS);
    expect(await releaseUpload(db, blobs, mine.id, "fe")).toBeNull();
    expect(await releaseUpload(db, blobs, bound.id, "be")).toBeNull();
    expect((await releaseUpload(db, blobs, mine.id, "be"))?.id).toBe(mine.id);
    expect(getAttachment(db, mine.id)).toBeUndefined();
    expect([blobCount(db), byteCount(db)]).toEqual([1, 1]);
  });

  test("a failed put drops the row it committed, and the sweep takes the catalog entry", async () => {
    const failing: BlobStore = { ...blobs, get: (s) => blobs.get(s), delete: (s) => blobs.delete(s), put: async () => { throw new Error("disk full"); } };
    await expect(storeAttachment(db, failing, "be", file("lost"))).rejects.toThrow("disk full");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get()).toEqual({ n: 0 });
    expect(blobCount(db)).toBe(0);
  });

  test("bytes are deleted before their catalog entry, so a failed delete is retried by the next sweep", async () => {
    const a = await store("be", file("gone"));
    await releaseUpload(db, { put: (s, d) => blobs.put(s, d), get: (s) => blobs.get(s), delete: async () => { throw new Error("EIO"); } }, a.id, "be");
    expect([blobCount(db), byteCount(db)]).toEqual([1, 1]);
    expect(await sweepBlobs(db, blobs)).toBe(1);
    expect([blobCount(db), byteCount(db)]).toEqual([0, 0]);
  });

  test("a store shared across processes never deletes bytes a row names, and a re-upload puts them back", async () => {
    const a = await store("be", file("raced"));
    // Another process's upload committed its row: a sweep here that saw none must not delete.
    await blobs.delete(a.sha256);
    expect(byteCount(db)).toBe(1);
    // Bytes a crash lost come back with the next upload of the same content.
    db.prepare(`DELETE FROM attachment_bytes`).run();
    await store("fe", file("raced"));
    expect(new TextDecoder().decode(await blobs.get(a.sha256))).toBe("raced");
  });

  test("binding takes only the caller's unbound uploads", async () => {
    const mine = await store("be", file("a"));
    const theirs = await store("fe", file("b"));
    const m = msg();
    expect(() => bindAttachments(db, [theirs.id], "be", { message_id: m }, LIMITS)).toThrow(`attachment ${theirs.id} isn't an unsent upload of yours`);
    expect(() => bindAttachments(db, [999], "be", { message_id: m }, LIMITS)).toThrow("isn't an unsent upload");
    expect(bindAttachments(db, [mine.id], "be", { message_id: m }, LIMITS)).toEqual([{ id: mine.id, filename: "f.txt", type: "text/plain", size: 1, sha256: mine.sha256 }]);
    expect(() => bindAttachments(db, [mine.id], "be", { message_id: msg() }, LIMITS)).toThrow("isn't an unsent upload");
    expect(withAttachments(db, "message", [{ id: m }, { id: m + 100 }])).toEqual([
      { id: m, attachments: [{ id: mine.id, filename: "f.txt", type: "text/plain", size: 1, sha256: mine.sha256 }] },
      { id: m + 100 },
    ]);
  });

  test("attachment_ids are checked for shape and count", () => {
    expect(attachmentIds(undefined)).toEqual([]);
    expect(attachmentIds([3, 3, 4])).toEqual([3, 4]);
    expect(() => attachmentIds(["3"])).toThrow("list of attachment ids");
    expect(() => attachmentIds([1, 2, 3, 4, 5, 6])).toThrow("at most 5");
  });

  test("a post binds its attachments in its own transaction; a refused post binds nothing", async () => {
    const up = await store("be", file(PNG, "shot.png", "image/png"));
    expect(() => post(db, "be", "e2e", "hi", 999, files([up.id]))).toThrow("parent_id");
    expect(getAttachment(db, up.id)!.post_id).toBeNull();
    const stranger = await store("fe", file("x"));
    expect(() => post(db, "be", "e2e", "hi", null, files([up.id, stranger.id]))).toThrow("isn't an unsent upload");
    expect(getAttachment(db, up.id)!.post_id).toBeNull();
    expect(() => post(db, "be", "e2e", "hi", null, { attachments: { ids: [up.id] } })).toThrow("this mode can't post files");
    expect(read(db, "be", "e2e").posts).toEqual([]);

    subscribe(db, "fe", "e2e", "push");
    const r = post(db, "be", "e2e", "see shot", null, files([up.id]));
    const info = { id: up.id, filename: "shot.png", type: "image/png", size: PNG.length, sha256: sha256Hex(PNG) };
    expect(r.attachments).toEqual([info]);
    const [item] = pendingFor(db, "fe");
    expect(boardNotification(item!).meta.attachments).toBe(`${up.id}:shot.png image/png 11B sha256:${sha256Hex(PNG)}`);
    expect(read(db, "fe", "e2e", { thread: r.post.id }).posts[0]!.attachments).toEqual([info]);
  });

  test("board_post takes attachment_ids, never paths, under the mode's limits", async () => {
    const up = await store("be", file("a"));
    expect(() => callBoardTool(db, "be", "board_post", { board: "e2e", body: "x", attachments: ["/etc/hosts"] })).toThrow("MCP process");
    expect(() => callBoardTool(db, "be", "board_post", { board: "e2e", body: "x", attachment_ids: [up.id] })).toThrow("this mode can't post files");
    const r = callBoardTool(db, "be", "board_post", { board: "e2e", body: "x", attachment_ids: [up.id] }, { attachmentLimits: LIMITS }).result as { attachments: unknown[] };
    expect(r.attachments).toEqual([{ id: up.id, filename: "f.txt", type: "text/plain", size: 1, sha256: up.sha256 }]);
  });

  test("unbound uploads are pruned after their TTL; pruned posts take their attachments", async () => {
    const old = await store("be", file("old"), { now: 1_000 });
    const p = post(db, "be", "e2e", "x", null, files([(await store("be", file("kept"), { now: 1_000 })).id]));
    expect(pruneUnbound(db, 1_001)).toBe(1);
    expect(getAttachment(db, old.id)).toBeUndefined();
    expect(await sweepBlobs(db, blobs)).toBe(1);
    expect(blobCount(db)).toBe(1);
    // Storing prunes, and sweeps what it pruned.
    const stale = await store("be", file("stale"), { now: 5_000 });
    await store("be", file("new"), { now: 5_000 + UNBOUND_TTL_MS + 1 });
    expect(getAttachment(db, stale.id)).toBeUndefined();
    expect([blobCount(db), byteCount(db)]).toEqual([2, 2]);
    prunePosts(db, Date.now() + 1);
    expect(getAttachment(db, p.attachments[0]!.id)).toBeUndefined();
    await sweepBlobs(db, blobs);
    expect([blobCount(db), byteCount(db)]).toEqual([1, 1]);
  });

  test("who may fetch: board viewers, the DM's two ends, an upload's uploader", async () => {
    const m = msg("be", "fe");
    const onDm = await store("be", file("dm"));
    bindAttachments(db, [onDm.id], "be", { message_id: m }, LIMITS);
    const dm = (h: string) => (id: number) => {
      const row = db.prepare(`SELECT sender, recipient FROM messages WHERE id = ?`).get(id) as { sender: string; recipient: string };
      return row.sender === h || row.recipient === h;
    };
    expect(canReadAttachment(db, "fe", getAttachment(db, onDm.id)!, dm("fe"))).toBe(true);
    expect(canReadAttachment(db, "sim", getAttachment(db, onDm.id)!, dm("sim"))).toBe(false);
    const loose = await store("be", file("loose"));
    expect(canReadAttachment(db, "be", loose, dm("be"))).toBe(true);
    expect(canReadAttachment(db, "fe", loose, dm("fe"))).toBe(false);
    const p = post(db, "be", "e2e", "x", null, files([(await store("be", file("post"))).id]));
    expect(canReadAttachment(db, "sim", getAttachment(db, p.attachments[0]!.id)!, dm("sim"))).toBe(true);
    expect(new TextDecoder().decode(await blobs.get(onDm.sha256))).toBe("dm");
  });
});
