import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentData,
  attachmentIds,
  bindAttachments,
  canReadAttachment,
  dropAttachments,
  getAttachment,
  pruneUnbound,
  releaseUpload,
  storeAttachment,
  withAttachments,
} from "./attachments.ts";
import { createBoard, pendingFor, post, prunePosts, read, subscribe } from "./boards.ts";
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
  sanitizeFilename,
  saveAttachment,
  serverBusDir,
  sniffType,
  type AttachmentFile,
} from "../shared/attachments.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file = (data: Uint8Array | string, filename = "f.txt", type = "text/plain"): AttachmentFile => ({
  filename,
  type,
  data: typeof data === "string" ? new TextEncoder().encode(data) : data,
});
const blobCount = (db: Database) => (db.prepare(`SELECT COUNT(*) AS n FROM attachment_blobs`).get() as { n: number }).n;

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

  test("meta lists attachments and parses back to ids", () => {
    const meta = formatAttachmentsMeta([
      { id: 12, filename: "shot 1.png", type: "image/png", size: 340 * 1024 },
      { id: 13, filename: "n.md", type: "text/markdown", size: 900 },
    ]);
    expect(meta).toBe("12:shot 1.png image/png 340KB; 13:n.md text/markdown 900B");
    expect(parseAttachmentsMeta(meta)).toEqual([12, 13]);
    expect(parseAttachmentsMeta(undefined)).toEqual([]);
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

  test("attachRoots resolves cwd, temp and BUS_ATTACH_ROOTS; missing roots drop out", () => {
    const roots = attachRoots({ BUS_ATTACH_ROOTS: `${outside}:/no/such/dir` }, root);
    expect(roots).toContain(root);
    expect(roots).toContain(outside);
    expect(roots).toContain(realpathSync(tmpdir()));
    expect(roots).not.toContain("/no/such/dir");
  });

  test("saving goes to the default directory or a dir under a root, private to the user", async () => {
    const a = { id: 7, filename: "shot.png", type: "image/png", size: PNG.length };
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
    const a = { id: 9, filename: "evil.md", type: "text/markdown", size: 2 };
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
    const a = { id: 8, filename: "shot.png", type: "image/png", size: PNG.length };
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
      expect(storeAttachment(db, "be", file("x")).id).toBeGreaterThan(0);
    } finally {
      await holder.exited;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    // Each mode brings its own messages table; this is the shape the store needs.
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT)`);
    initCoreSchema(db);
    createBoard(db, "be", "e2e", "fixtures");
  });
  const msg = (sender = "be", recipient = "fe") =>
    Number(db.prepare(`INSERT INTO messages (sender, recipient) VALUES (?, ?)`).run(sender, recipient).lastInsertRowid);

  test("identical bytes share one blob; it goes with the last attachment naming it", () => {
    const a = storeAttachment(db, "be", file("same"));
    const b = storeAttachment(db, "fe", file("same", "other.txt"));
    expect(a.sha256).toBe(b.sha256);
    expect(blobCount(db)).toBe(1);
    const m1 = msg();
    const m2 = msg("fe", "be");
    bindAttachments(db, [a.id], "be", { message_id: m1 });
    bindAttachments(db, [b.id], "fe", { message_id: m2 });
    dropAttachments(db, "message", "?", m1);
    expect(getAttachment(db, a.id)).toBeUndefined();
    expect(blobCount(db)).toBe(1);
    dropAttachments(db, "message", "?", m2);
    expect(blobCount(db)).toBe(0);
  });

  test("releasing drops only the caller's own unsent upload, and its blob once nothing names it", () => {
    const mine = storeAttachment(db, "be", file("a"));
    const bound = storeAttachment(db, "be", file("b"));
    bindAttachments(db, [bound.id], "be", { message_id: msg() });
    expect(releaseUpload(db, mine.id, "fe")).toBeNull();
    expect(releaseUpload(db, bound.id, "be")).toBeNull();
    expect(releaseUpload(db, mine.id, "be")?.id).toBe(mine.id);
    expect(getAttachment(db, mine.id)).toBeUndefined();
    expect(blobCount(db)).toBe(1);
  });

  test("binding takes only the caller's unbound uploads", () => {
    const mine = storeAttachment(db, "be", file("a"));
    const theirs = storeAttachment(db, "fe", file("b"));
    const m = msg();
    expect(() => bindAttachments(db, [theirs.id], "be", { message_id: m })).toThrow(`attachment ${theirs.id} isn't an unsent upload of yours`);
    expect(() => bindAttachments(db, [999], "be", { message_id: m })).toThrow("isn't an unsent upload");
    expect(bindAttachments(db, [mine.id], "be", { message_id: m })).toEqual([{ id: mine.id, filename: "f.txt", type: "text/plain", size: 1 }]);
    expect(() => bindAttachments(db, [mine.id], "be", { message_id: msg() })).toThrow("isn't an unsent upload");
    expect(withAttachments(db, "message", [{ id: m }, { id: m + 100 }])).toEqual([
      { id: m, attachments: [{ id: mine.id, filename: "f.txt", type: "text/plain", size: 1 }] },
      { id: m + 100 },
    ]);
  });

  test("attachment_ids are checked for shape and count", () => {
    expect(attachmentIds(undefined)).toEqual([]);
    expect(attachmentIds([3, 3, 4])).toEqual([3, 4]);
    expect(() => attachmentIds(["3"])).toThrow("list of attachment ids");
    expect(() => attachmentIds([1, 2, 3, 4, 5, 6])).toThrow("at most 5");
  });

  test("a post binds its attachments in its own transaction; a refused post binds nothing", () => {
    const up = storeAttachment(db, "be", file(PNG, "shot.png", "image/png"));
    expect(() => post(db, "be", "e2e", "hi", 999, { attachment_ids: [up.id] })).toThrow("parent_id");
    expect(getAttachment(db, up.id)!.post_id).toBeNull();
    const stranger = storeAttachment(db, "fe", file("x"));
    expect(() => post(db, "be", "e2e", "hi", null, { attachment_ids: [up.id, stranger.id] })).toThrow("isn't an unsent upload");
    expect(getAttachment(db, up.id)!.post_id).toBeNull();
    expect(read(db, "be", "e2e").posts).toEqual([]);

    subscribe(db, "fe", "e2e", "push");
    const r = post(db, "be", "e2e", "see shot", null, { attachment_ids: [up.id] });
    const info = { id: up.id, filename: "shot.png", type: "image/png", size: PNG.length };
    expect(r.attachments).toEqual([info]);
    const [item] = pendingFor(db, "fe");
    expect(boardNotification(item!).meta.attachments).toBe(`${up.id}:shot.png image/png 11B`);
    expect(read(db, "fe", "e2e", { thread: r.post.id }).posts[0]!.attachments).toEqual([info]);
  });

  test("board_post takes attachment_ids, never paths", () => {
    const up = storeAttachment(db, "be", file("a"));
    expect(() => callBoardTool(db, "be", "board_post", { board: "e2e", body: "x", attachments: ["/etc/hosts"] })).toThrow("MCP process");
    const r = callBoardTool(db, "be", "board_post", { board: "e2e", body: "x", attachment_ids: [up.id] }).result as { attachments: unknown[] };
    expect(r.attachments).toEqual([{ id: up.id, filename: "f.txt", type: "text/plain", size: 1 }]);
  });

  test("unbound uploads are pruned after their TTL; pruned posts take their attachments", () => {
    const old = storeAttachment(db, "be", file("old"), 1_000);
    const p = post(db, "be", "e2e", "x", null, { attachment_ids: [storeAttachment(db, "be", file("kept"), 1_000).id] });
    pruneUnbound(db, 1_001);
    expect(getAttachment(db, old.id)).toBeUndefined();
    expect(blobCount(db)).toBe(1);
    // Storing prunes too.
    const stale = storeAttachment(db, "be", file("stale"), 5_000);
    storeAttachment(db, "be", file("new"), 5_000 + UNBOUND_TTL_MS + 1);
    expect(getAttachment(db, stale.id)).toBeUndefined();
    prunePosts(db, Date.now() + 1);
    expect(getAttachment(db, p.attachments[0]!.id)).toBeUndefined();
    expect(blobCount(db)).toBe(1);
  });

  test("who may fetch: board viewers, the DM's two ends, an upload's uploader", () => {
    const m = msg("be", "fe");
    const onDm = storeAttachment(db, "be", file("dm"));
    bindAttachments(db, [onDm.id], "be", { message_id: m });
    const dm = (h: string) => (id: number) => {
      const row = db.prepare(`SELECT sender, recipient FROM messages WHERE id = ?`).get(id) as { sender: string; recipient: string };
      return row.sender === h || row.recipient === h;
    };
    expect(canReadAttachment(db, "fe", getAttachment(db, onDm.id)!, dm("fe"))).toBe(true);
    expect(canReadAttachment(db, "sim", getAttachment(db, onDm.id)!, dm("sim"))).toBe(false);
    const loose = storeAttachment(db, "be", file("loose"));
    expect(canReadAttachment(db, "be", loose, dm("be"))).toBe(true);
    expect(canReadAttachment(db, "fe", loose, dm("fe"))).toBe(false);
    const p = post(db, "be", "e2e", "x", null, { attachment_ids: [storeAttachment(db, "be", file("post")).id] });
    expect(canReadAttachment(db, "sim", getAttachment(db, p.attachments[0]!.id)!, dm("sim"))).toBe(true);
    expect(new TextDecoder().decode(attachmentData(db, onDm.sha256))).toBe("dm");
  });
});
