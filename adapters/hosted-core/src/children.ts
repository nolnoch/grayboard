// A descendant session's registration under its top-level root, and its end.
// Both run over a temporary subscriber wire: session_register exists only on
// the subscriber role and must run before the child's first native call (a
// child row that already bound a name refuses with child_bound).
import type { Wire } from "./wire.js";

// Opens a subscriber wire whose `_meta[sessionKey]` is `sessionID`, runs
// `call` on it, and closes it.
export type Temporary = <T>(sessionID: string, call: (wire: Wire) => Promise<T>) => Promise<T>;

// `root` and `child` are raw session ids; `via` lists the intermediate raw ids
// from the root down, empty for a direct child (sent as no `via`).
export async function register(temporary: Temporary, path: { root: string; via: string[]; child: string }) {
  await temporary(path.root, wire => wire.call("session_register", { child: path.child, ...(path.via.length ? { via: path.via } : {}) }));
}

// session_end with no argument over the child's own raw id: the tool's
// `session` argument is a hosted session id, never a raw one.
export async function end(temporary: Temporary, path: { child: string }) {
  await temporary(path.child, wire => wire.call("session_end"));
}
