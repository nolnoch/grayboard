// The one seam between the harness-neutral Controller and a host: OpenCode V2
// (host-owned grant, human approval) or a harness adapter (pi, omp, Claude
// Code: adapter-owned grant, every root approved).
import type { Identity, Item } from "./model.js";
import type { SessionPath } from "./sessions.js";

export type Configuration = { type: "remote"; url: string; issuer: string; clientID: string; scope: string; configHash: string };
export type Enrollment = { version: 2; sessionID: string; configuration: Configuration; name?: string };
export type Delivery = { mode: "push" | "poll"; source: string };
export interface KeyValueStorage { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }

export interface HostPort<E extends Enrollment = Enrollment> {
  readonly harness: string;      // "OpenCode" | "pi" | "omp" | "Claude Code", used in messages
  readonly resumeHint: string;   // how this harness restarts a paused root: "explicitly enroll again" | "run /grayboard resume" | "call any grayboard tool to retry"
  readonly loginAction: string;  // how this harness signs in again, for AccessExpired: "reconnect or sign in using OpenCode" | "run /grayboard login"
  readonly sessionKey: string;   // "ai.opencode/sessionID" | "io.github.nolnoch.grayboard/sessionID"
  readonly client: { name: string; version: string };
  readonly delivery?: Delivery;  // adapters only; OpenCode omits it
  readonly storage: KeyValueStorage;
  place(): string;               // bind `where`; captured at construction, guard refuses once it differs
  ancestry(sessionID: string): Promise<SessionPath>; // {sessionID, root, via}; throws AncestryError
  credential: CredentialPort<E>;
  approval: ApprovalPort<E> | null; // null = adapter-owned grant: every root of this installation is approved
  // Idempotent per stableID; resolves once the host accepted the item. `identity`
  // is the lease's: an adapter marks its own user's human (`<email>/human`) by it.
  // `signal` is the run loop's: a host whose admit waits (Claude Code's
  // `initialized`) races it, so a stop releases the wait without a pause.
  admit(e: E, item: Item, stableID: string, identity: Identity, signal: AbortSignal): Promise<void>;
}
export interface CredentialPort<E extends Enrollment> {
  capture(sessionID: string): Promise<E>;            // a fresh enrollment for this root
  check(e: E): Promise<void>;                         // throws Refusal("binding") when the credential behind e changed; runs in every guard
  watch(e: E, drift: () => void): Promise<{ dispose(): Promise<void> }>;
  token(e: E): Promise<string>;                       // current access token; throws AccessExpired only when a new login is needed
  unauthorized(e: E, token: string): Promise<void>;   // called on 401 for `token`; returns when the next token() may succeed, else throws
}
export interface ApprovalPort<E extends Enrollment> {
  key(e: E): string;                                   // OpenCode: enrollmentHash
  // `roots`: every live root's sessionID, `e`'s included. The saved root list
  // becomes exactly these, so a root restore dropped (ended, or edited) is pruned.
  save(e: E, approval: E, enabled: boolean, roots: readonly string[]): Promise<void>;
  approved(e: E, approval: E): Promise<boolean>;
  // Restore input, one entry per saved root; `approval: null` is a saved
  // record that no longer verifies (edited), which restore reports and skips.
  saved(): Promise<Array<{ sessionID: string; approval: E | null; enabled: boolean }>>;
}
