// Predicates over the application's own delivery shape (DeliveryEvent,
// src/server/application.ts), shared by both test drivers: AppSession.next
// matches its events with them, HostedSession.next an inbox item's event.
import type { DeliveryEvent, DirectMessage } from "../../src/server/application.ts";
import type { Pending } from "../../src/shared/notifications.ts";

export type DirectEvent = Extract<DeliveryEvent, { kind: "direct" }>;
export type BoardEvent = Extract<DeliveryEvent, { kind: "board" }>;

// A direct message, matching `pred` when given.
export function direct(pred: (message: DirectMessage) => boolean = () => true) {
  return (e: { kind: string }): e is DirectEvent => e.kind === "direct" && pred((e as DirectEvent).message);
}

// A board item (a push or a digest), matching `pred` when given.
export function board(pred: (item: Pending) => boolean = () => true) {
  return (e: { kind: string }): e is BoardEvent => e.kind === "board" && pred((e as BoardEvent).item);
}
