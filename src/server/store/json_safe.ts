// Strings a JSON column (and Postgres text) can hold (#807 P3 C7 decision 3): Postgres refuses NUL in text (22021) and
// in jsonb (22P05), and a lone UTF-16 surrogate in jsonb (22P02). Audit rows and Slack progress carry user strings
// (filenames, refusal reasons, client names), and refusing them would fail the audited action, so both backends store
// each as U+FFFD instead. No runtime imports: the SQLite store (db.ts) and the Postgres store (pg/) share it.

// NUL to U+FFFD, then every lone surrogate to U+FFFD.
export function textSafe(s: string): string {
  return s.replaceAll("\0", "\uFFFD").toWellFormed();
}

export function textSafeOrNull(s: string | null): string | null {
  return s === null ? null : textSafe(s);
}

// A deep copy of a JSON value with every string, keys included, made textSafe; a value with toJSON (a Date) is
// replaced by what it gives, as JSON.stringify would. Anything else is copied as is.
export function jsonSafe<T>(value: T): T {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return jsonSafe((value as unknown as { toJSON(): unknown }).toJSON()) as T;
  }
  if (typeof value === "string") return textSafe(value) as T;
  if (Array.isArray(value)) return value.map(jsonSafe) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[textSafe(k)] = jsonSafe(v);
    return out as T;
  }
  return value;
}

// A JSON text with the same treatment: its strings as jsonSafe leaves them. Text with nothing to replace is returned
// unchanged (no reparse): JSON.stringify writes a NUL as \u0000 and a lone surrogate as \udXXX, so neither can hide
// without one of those escapes, a raw NUL or a raw lone surrogate.
export function jsonTextSafe(text: string): string {
  if (!text.includes("\0") && text.isWellFormed() && !/\\u(0000|d[89a-f])/i.test(text)) return text;
  return JSON.stringify(jsonSafe(JSON.parse(textSafe(text))));
}
