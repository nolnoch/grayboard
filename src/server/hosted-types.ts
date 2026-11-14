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
// A hold the server took from a hosted root (#453): its address, why, and whether it was the root's primary.
export type HostedLost = { alias: string; reason: string; primary: boolean };
// Who reads a lost hold: the agent (the notice, taken once) and the root's Controller (reported by every
// subscriber whoami until its next delivery_open acknowledges it, so a lost response can't lose it).
export type LostReader = "agent" | "controller";
export interface HostedStore {
  atomic<T>(fn: () => T): T;
  subscribe(fn: () => void): () => void;
  get(id: string): HostedSession | undefined;
  // Whether the session ID is a hosted session's: a root's ownership row
  // stays after it ends; a child's row only while it is registered.
  owned(id: string): boolean;
  // Every row but parked children (#566): what the limits count and the sweeps scan. `get` still returns a
  // parked row, and `children` lists a root's children, parked or not.
  all(): HostedSession[];
  children(root: string): HostedSession[];
  // Park an idle child, or make a parked one active again under its root's current grant (#566).
  park(session: string, now: number): void;
  unpark(session: string, grant: string, now: number): void;
  insert(row: HostedSession): void;
  update(row: HostedSession): void;
  // `suggested`: the ownership's suggested name (#443), recorded in its `hosted.ownership_started` audit (#522).
  start(session: string, user: number, client: string, now: number, suggested?: string | null): number;
  end(session: string, reason: HostedEnd, now: number, deadline?: number): boolean;
  childEnd(session: string, now: number, reason: ChildEnd): void;
  // A root's lost holds `reader` hasn't taken, oldest first (#453). `lose` records one in the revocation's
  // transaction (restating an alias already pending, for both readers); `lost` reads them; `tellLost` takes the
  // agent's; `reportLost` returns the Controller's, marking them reported; `seeLost` takes the reported ones (its
  // delivery_open: the Controller applied them before opening); `forgetLost` drops an alias the root bound again.
  // A hold both readers took is deleted.
  lose(session: string, lost: HostedLost, now: number): void;
  lost(session: string, reader: LostReader): HostedLost[];
  tellLost(session: string, now: number): HostedLost[];
  reportLost(session: string, now: number): HostedLost[];
  seeLost(session: string, now: number): HostedLost[];
  forgetLost(session: string, alias: string): void;
  // The server's last recorded liveness (epoch ms), absent before the first
  // heartbeat on this schema. A restart credits leases with the downtime (#423).
  aliveAt(): number | undefined;
  heartbeat(now: number): void;
}
