// A cancel can cross a tool result on the wire (#182 audit 7): the client has
// already given the request up, so it throws the result away, and the SDK
// ignores a cancel for a request it has answered. Whatever that result carried
// (a bind's outcome, notices, refreshed instructions) is lost on both sides.
// stdio is ordered, so the cancel reaches this process before the client's
// next request: watch the transport for it, and requeue what the result
// carried for the next one. Both modes use it.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CancelledNotificationSchema, type RequestId } from "@modelcontextprotocol/sdk/types.js";

// Results answered recently enough that their cancel may still be in flight.
// Calls run concurrently, so more than one can be; a cancel follows its
// request's result by at most one round trip, never by this many results.
const KEEP = 32;

export class LateCancels {
  private answered = new Map<RequestId, () => void>();

  /** Tap `transport` (after `server.connect`) ahead of the SDK's own handling. */
  watch(transport: Transport): void {
    const inner = transport.onmessage;
    transport.onmessage = (message, extra) => {
      const cancel = CancelledNotificationSchema.safeParse(message);
      if (cancel.success && cancel.data.params.requestId !== undefined) {
        const lost = this.answered.get(cancel.data.params.requestId);
        if (lost) {
          this.answered.delete(cancel.data.params.requestId);
          lost();
        }
      }
      inner?.(message, extra);
    };
  }

  /** Request `id` was answered; if its cancel arrives anyway, run `lost`. */
  answer(id: RequestId, lost: () => void): void {
    this.answered.set(id, lost);
    if (this.answered.size > KEEP) this.answered.delete(this.answered.keys().next().value!);
  }
}
