// Tool calls run concurrently, but none overlaps a bind (#182 audit 11): a
// call that started under the old name could otherwise land on it after its
// claims moved, or be cut off with its connection. Both modes use it.
export class BindGate {
  private active = 0;
  private drained: (() => void) | null = null;
  private closed: Promise<unknown> | null = null;
  private held: Promise<unknown> | null = null;

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

  /** Run a bind alone: after the calls in flight finish, and before any that arrive meanwhile. */
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
      const reopen = () => {
        if (this.closed === closed) this.closed = null;
        open();
      };
      const held = this.held;
      this.held = null;
      if (held) held.then(reopen, reopen);
      else reopen();
    }
  }

  /** Called inside a bind: keep calls waiting after its result, until `p` settles. */
  holdUntil(p: Promise<unknown>): void {
    this.held = p;
  }
}
