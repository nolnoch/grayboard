// The roster store (#124's rescoped shape under #293): the module's OWN
// SQLite database, kept in the module's data dir with its OWN retention.
// It never writes to boards-held state — principle 7 (#288) and the #293
// constraints: messages aren't knowledge, and the module's store outlives
// the bus's retention clock, not the other way round.
//
// bun:sqlite here is fine: the server's isolation test
// (src/server/db.test.ts) scans src/ only; this module is outside src/ by
// design (#293's boundary).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type FleetRow = { name: string; queue_board: string; status_board: string; created_at: number };
export type MemberRow = { fleet: string; handle: string; added_at: number };
export type PresenceRow = { fleet: string; handle: string; online: number; checked_at: number };

export type Store = {
  db: Database;
  // Fleet and membership state (upserted by config sync).
  fleets(): FleetRow[];
  members(fleet: string): MemberRow[];
  addFleet(f: { name: string; queueBoard: string; statusBoard: string }, now: number): void;
  removeFleet(name: string): void;
  addMember(fleet: string, handle: string, now: number): void;
  removeMember(fleet: string, handle: string): void;
  // Presence, as last observed through the public surface.
  setPresence(fleet: string, handle: string, online: boolean, now: number): void;
  presence(fleet: string): PresenceRow[];
  // The module's own audit trail; retention prunes it.
  log(kind: string, detail: string, now: number): void;
  events(kind?: string): { at: number; kind: string; detail: string }[];
  // Deletes audit rows older than `olderThan`; returns the rows deleted.
  prune(olderThan: number, now: number): number;
  // Small key/value scratch (e.g. the last posted status summary per fleet).
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleets (
  name TEXT PRIMARY KEY,
  queue_board TEXT NOT NULL,
  status_board TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  fleet TEXT NOT NULL,
  handle TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (fleet, handle)
);
CREATE TABLE IF NOT EXISTS presence (
  fleet TEXT NOT NULL,
  handle TEXT NOT NULL,
  online INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (fleet, handle)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "roster.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return {
    db,
    fleets() {
      return db.query("SELECT name, queue_board, status_board, created_at FROM fleets ORDER BY name").all() as FleetRow[];
    },
    members(fleet) {
      return db.query("SELECT fleet, handle, added_at FROM members WHERE fleet = ? ORDER BY handle").all(fleet) as MemberRow[];
    },
    addFleet(f, now) {
      db.query("INSERT INTO fleets (name, queue_board, status_board, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING").run(
        f.name, f.queueBoard, f.statusBoard, now,
      );
    },
    removeFleet(name) {
      db.query("DELETE FROM members WHERE fleet = ?").run(name);
      db.query("DELETE FROM presence WHERE fleet = ?").run(name);
      db.query("DELETE FROM fleets WHERE name = ?").run(name);
    },
    addMember(fleet, handle, now) {
      db.query("INSERT INTO members (fleet, handle, added_at) VALUES (?, ?, ?) ON CONFLICT(fleet, handle) DO NOTHING").run(fleet, handle, now);
    },
    removeMember(fleet, handle) {
      db.query("DELETE FROM members WHERE fleet = ? AND handle = ?").run(fleet, handle);
      db.query("DELETE FROM presence WHERE fleet = ? AND handle = ?").run(fleet, handle);
    },
    setPresence(fleet, handle, online, now) {
      db.query(
        "INSERT INTO presence (fleet, handle, online, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(fleet, handle) DO UPDATE SET online = excluded.online, checked_at = excluded.checked_at",
      ).run(fleet, handle, online ? 1 : 0, now);
    },
    presence(fleet) {
      return db.query("SELECT fleet, handle, online, checked_at FROM presence WHERE fleet = ? ORDER BY handle").all(fleet) as PresenceRow[];
    },
    log(kind, detail, now) {
      db.query("INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)").run(now, kind, detail);
    },
    events(kind) {
      return kind
        ? (db.query("SELECT at, kind, detail FROM events WHERE kind = ? ORDER BY id").all(kind) as { at: number; kind: string; detail: string }[])
        : (db.query("SELECT at, kind, detail FROM events ORDER BY id").all() as { at: number; kind: string; detail: string }[]);
    },
    prune(olderThan, now) {
      return db.query("DELETE FROM events WHERE at < ?").run(now - olderThan).changes;
    },
    meta(key) {
      return (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
    },
    setMeta(key, value) {
      db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    close() {
      db.close();
    },
  };
}
