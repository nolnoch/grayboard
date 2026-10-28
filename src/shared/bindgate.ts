// Tool calls run concurrently, but none overlaps a bind or an unbind (#182
// audit 11): a call picks the address it acts as from the session's holds
// when it starts (#284 S3, S4, S14), so a change to them mid-call would let
// it act as an alias the session no longer holds. Both modes use it.
export class BindGate {
  private active = 0;
  private drained: (() => void) | null = null;
  private closed: Promise<unknown> | null = null;

  /** Run a tool call once no bind is waiting or running. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    while (this.closed) await this.closed;
    this.active++;
    try {
      return await fn();
    } finally {
      if (--this.active === 0) this.drained?.();
    }
  }

  /** Run a bind or unbind alone: after the calls in flight finish, and before any that arrive meanwhile. */
  async bind<T>(fn: () => Promise<T>): Promise<T> {
    while (this.closed) await this.closed;
    let open!: () => void;
    const closed = new Promise<void>((r) => { open = r; });
    this.closed = closed;
    try {
      if (this.active) await new Promise<void>((r) => { this.drained = r; });
      this.drained = null;
      return await fn();
    } finally {
      if (this.closed === closed) this.closed = null;
      open();
    }
  }
}
