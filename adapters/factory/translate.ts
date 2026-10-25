// The translator registry's type (docs/future/factory.md §6): a translator
// maps a delegation payload to a harness-native spawn rendering. It owns one
// harness; `translate` returns the full in-thread reply body the module sends
// back, or null when this harness can't serve the persona (no agent file
// matched) — the module then tries the next translator, and falls back to the
// skeleton receipt when none matches.
//
// The payload arrives through the module's parser (delegate.ts): the fields
// are DATA by the sender's contract. A translator's rendered section is its
// own words, never the sender's — the request's authority rules (the DM
// channel's sender is the only authority) still gate the spawn.
import type { DelegationPayload } from "./delegate.ts";

export type Translator = {
  // The harness this translator renders for ("pi", "claude", "opencode").
  harness: string;
  translate(payload: DelegationPayload): string | null;
};
