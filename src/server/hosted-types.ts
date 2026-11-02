export type HostedSession = {
  session_id: string; ownership_id: number; user_id: number; client_id: string; grant_id: string;
  source_session_id: string; writes_as: string | null; bind_gen: number; root_session_id: string | null;
  place: string | null; lease_deadline: number | null; created_at: number; last_seen_at: number;
};
export type HostedEnd = "idle" | "closed" | "revoked" | "disabled" | "expired";
// A hold the server took from a hosted root (#453): its address, why, and whether it was the root's primary.
export type HostedLost = { alias: string; reason: string; primary: boolean };
// Who takes a lost hold, each once: the agent (the notice) and the root's Controller (its subscriber whoami).
export type LostReader = "agent" | "controller";
export interface HostedStore {
  atomic<T>(fn: () => T): T;
  subscribe(fn: () => void): () => void;
  get(id: string): HostedSession | undefined;
  // Whether the session ID is a hosted session's: a root's ownership row
  // stays after it ends; a child's row only while it is registered. The WSS
  // session lifecycle (#284 S4's grace, a revocation's end) never ends a
  // hosted ID.
  owned(id: string): boolean;
  all(): HostedSession[];
  insert(row: HostedSession): void;
  update(row: HostedSession): void;
  start(session: string, user: number, client: string, now: number): number;
  end(session: string, reason: HostedEnd, now: number, deadline?: number): boolean;
  childEnd(session: string, now: number): void;
  // A root's lost holds `reader` hasn't taken, oldest first (#453): `lose` records one in the revocation's
  // transaction (restating an alias already pending, for both readers), `lost` reads them, `takeLost` reads and
  // marks them, deleting a hold both readers took.
  lose(session: string, lost: HostedLost, now: number): void;
  lost(session: string, reader: LostReader): HostedLost[];
  takeLost(session: string, reader: LostReader, now: number): HostedLost[];
  // The server's last recorded liveness (epoch ms), absent before the first
  // heartbeat on this schema. A restart credits leases with the downtime (#423).
  aliveAt(): number | undefined;
  heartbeat(now: number): void;
}
