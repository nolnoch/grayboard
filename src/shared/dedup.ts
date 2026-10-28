// How long a repeat of an append write (dm_send, board_post, delegate) is
// answered with the first result (#254). It must outlast a harness's answer
// timeout plus the model's next turn; a wider window swallows more deliberate
// repeats. A leaf module: core, the plugin and the server all read it.
export const WRITE_DEDUP_WINDOW_MS = 10 * 60_000;
export const WRITE_DEDUP_WINDOW_TEXT = `${WRITE_DEDUP_WINDOW_MS / 60_000} minutes`;

// Sorted keys, no whitespace, strings encoded as JSON (UTF-8), no Unicode
// normalization. A key whose value is undefined is left out, as
// JSON.stringify does; any other value JSON can't carry is refused, so two
// different calls can never encode alike.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: ${v} isn't JSON`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof v} isn't JSON`);
}
