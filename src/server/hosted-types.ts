export type HostedSession = {
  session_id: string; ownership_id: number; user_id: number; client_id: string; grant_id: string;
  source_session_id: string; name: string | null; bind_gen: number; root_session_id: string | null;
  place: string | null; lease_deadline: number | null; created_at: number; last_seen_at: number;
};
export type HostedEnd = "idle" | "closed" | "revoked" | "disabled" | "expired";
export interface HostedStore {
  atomic<T>(fn: () => T): T;
  subscribe(fn: () => void): () => void;
  get(id: string): HostedSession | undefined;
  all(): HostedSession[];
  insert(row: HostedSession): void;
  update(row: HostedSession): void;
  start(session: string, user: number, client: string, now: number): number;
  end(session: string, reason: HostedEnd, now: number, deadline?: number): boolean;
  childEnd(session: string, now: number): void;
}
