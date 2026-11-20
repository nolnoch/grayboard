import type { Database } from "bun:sqlite";

// Runs one write transaction, for core code both modes share (attachments). Local mode runs it now
// (immediateTx); the server queues it behind its other writes (#807 D4), so the caller awaits it. fn is synchronous:
// nothing awaits inside a transaction. fn gets the connection its transaction runs on and writes through it, not
// through a connection it closed over: on the server that's the queued body's own (#807 P1c-15c-2). Its own module, with a type-only bun:sqlite import: core modules the
// node-target bundles carry (claims via bindings and tools) must not pull in core/sqlite.ts's runtime import.
export type WriteTx = <T>(fn: (db: Database) => T) => T | Promise<T>;
export const immediateTx = (db: Database): WriteTx => fn => db.transaction(() => fn(db)).immediate();
