// The hosted rows' types. The group's interface is store/hosted.ts's (#807 P3 C8a), re-exported here for its callers.
import type { MessageRow } from "./store/messages.ts";
export type { HostedPatch, HostedStore } from "./store/hosted.ts";
export type HostedSession = {
  session_id: string; ownership_id: number; user_id: number; client_id: string; grant_id: string;
  source_session_id: string; writes_as: string | null; bind_gen: number; root_session_id: string | null;
  place: string | null; lease_deadline: number | null; created_at: number; last_seen_at: number;
  // The name the root's first request suggested (#443), fixed for its life; a child's is null.
  suggested: string | null;
  // When the sweep parked this child for idleness (#566); null while active, and always null for a root.
  parked_at: number | null;
};
export type HostedEnd = "idle" | "closed" | "revoked" | "disabled" | "expired";
// Why a child row ended (#584): its own session_end, or the parked ceiling evicting it.
export type ChildEnd = "closed" | "evicted";
// A child ID a release ended (#475 item 1), and the handles its end woke, for the application to run after commit.
// `bounces`: the end's bounces, read in its transaction, so they're pushed at its commit (#807 P3 A7i).
export type EndedChild = { id: string; at: number; wake: string[]; bounces: MessageRow[] };
// A hold the server took from a hosted root (#453): its address, why, and whether it was the root's primary.
export type HostedLost = { alias: string; reason: string; primary: boolean };
// Who reads a lost hold: the agent (the notice, taken once) and the root's Controller (reported by every
// subscriber whoami until its next delivery_open acknowledges it, so a lost response can't lose it).
export type LostReader = "agent" | "controller";
