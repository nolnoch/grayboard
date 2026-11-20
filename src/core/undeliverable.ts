// An ID's deliverability refusal (#284 S18): the error class and the decision over the ID's row, kept out of
// session_end.ts (which runs SQL on a bun:sqlite Database) so the Postgres store (src/server/store/pg/session_end.ts,
// #807 P3 C10d1) builds the same refusal from its own reads. session_end.ts re-exports Undeliverable.
import { CoreError } from "./errors.ts";

/**
 * assertDeliverableId's refusal. Its message reads `<code>: <detail>`, the
 * text a local tool error shows; the server sends `code` as the error
 * frame's code and `detail` as its message, so both modes read the same.
 */
export class Undeliverable extends CoreError {
  constructor(
    readonly code: "not_found" | "id_ended" | "no_delivery" | "child_session",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export function heldText(held: string[]): string {
  return held.length ? `it held ${held.map((a) => `\`${a}\``).join(", ")}` : "it held no alias";
}

/** The ids row columns the decision reads; `held` parses held_aliases_json, asked only for an ended ID. */
export type DeliverabilityRow = { ended_at: number | null; held: () => string[]; delivery: string; writes_as: string | null; viewer: boolean; root_id: string | null };

/**
 * Why `id` can't receive a send or mention, or null, from its row (null: no row). `rootPrimary` names a child's
 * root's primary address; asked only for a child.
 */
export function undeliverableFrom(id: string, r: DeliverabilityRow | null, rootPrimary: (root: string) => string): Undeliverable | null {
  if (!r || r.viewer) return new Undeliverable("not_found", `no session ${id}`);
  if (r.root_id !== null) {
    return new Undeliverable("child_session", `${id} is a subagent acting under session ${r.root_id} and receives nothing; send to ${rootPrimary(r.root_id)}`);
  }
  if (r.ended_at != null) {
    return new Undeliverable("id_ended", `${id} ended at ${new Date(r.ended_at).toISOString()}; ${heldText(r.held())}`);
  }
  if (r.delivery === "none") {
    return new Undeliverable("no_delivery", `${id} is a tools-only session and receives nothing${r.writes_as ? `; send to ${r.writes_as}` : ""}`);
  }
  return null;
}
