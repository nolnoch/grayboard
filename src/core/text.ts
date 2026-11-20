// Text cleaners for what a session or a binder reports (#284 S12, #364, #372), shared by both modes. Kept out of
// boards.ts, which runs statements on a bun:sqlite Database, so a Postgres store can run them too (#807 P3 C10a-b).
import { SESSION_FACT_MAX } from "../shared/protocol.ts";

// Bidi marks, embeddings, overrides and isolates (U+061C, U+200E-F,
// U+202A-E, U+2066-9) and zero-width characters (U+200B, U+2060, U+FEFF):
// they reorder or hide what a peer reads (#372). ZWJ (U+200D) builds emoji
// sequences and ZWNJ (U+200C) is orthographic in Persian and Indic text, so
// both stay; that's why this isn't all of \p{Cf}.
const INVISIBLE = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

/** Text as one line: whitespace runs to a space, other control and bidi/zero-width characters dropped, trimmed. */
export function oneLine(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim();
}

// A self-reported session fact (harness, model, effort; #284 S12) as stored:
// one line of at most SESSION_FACT_MAX characters, since peer_list puts it in
// other agents' prompts. Format characters (\p{Cf}: the bidi controls that
// could reorder what follows, direction marks, zero-width characters) go
// first, then the line is folded, then NFC, so match:{model} compares what a
// reader sees: a hosted client sends it over the network (#364). Empty is none.
export function cleanFact(v: string | null | undefined): string | null {
  return v ? oneLine(v.replace(/\p{Cf}/gu, "")).normalize("NFC").slice(0, SESSION_FACT_MAX).trim() || null : null;
}

// A session's place as stored: one line of at most 200 characters; empty is none.
export const cleanPlace = (place: string | null): string | null => (place === null ? "" : oneLine(place)).slice(0, 200) || null;
