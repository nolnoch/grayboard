import type { Database } from "bun:sqlite";

// Runs one write transaction, for core code both modes share (attachments, claim expiry). Local mode runs it now
// (immediateTx); the server queues it behind its other writes (#807 D4), so the caller awaits it. fn is synchronous:
// nothing awaits inside a transaction. Its own module, with a type-only bun:sqlite import: core modules the
// node-target bundles carry (claims via bindings and tools) must not pull in core/sqlite.ts's runtime import.
export type WriteTx = <T>(fn: () => T) => T | Promise<T>;
export const immediateTx = (db: Database): WriteTx => fn => db.transaction(fn).immediate();
