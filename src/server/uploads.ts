import { CoreError } from "../core/errors.ts";

// Bounds the upload bodies the server holds in memory at once. Each upload
// reserves its declared length before its body is read: within `total` across
// the server and `perUser` for one user. A reservation that doesn't fit waits
// until its request is aborted. Room across the server is first come first
// served; a user at their own cap waits without holding up anyone else.
export class UploadGate {
  private inFlight = 0;
  private readonly byUser = new Map<string, number>();
  private readonly waiting: { user: string; bytes: number; grant: () => void }[] = [];

  constructor(
    private readonly total: number,
    private readonly perUser: number,
  ) {}

  // Resolves with the release, once `bytes` fits. `bytes` must be within
  // perUser and total, as the server's caps guarantee.
  reserve(user: string, bytes: number, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const entry = {
        user,
        bytes,
        grant: () => {
          signal.removeEventListener("abort", abort);
          resolve(this.take(user, bytes));
        },
      };
      const abort = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
        this.pump();
      };
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  private fits(user: string, bytes: number): boolean {
    return this.inFlight + bytes <= this.total && (this.byUser.get(user) ?? 0) + bytes <= this.perUser;
  }

  // Grants waiters in order. One that doesn't fit the server's room stops the
  // pass, so a large upload isn't starved by smaller ones behind it. One that
  // fits the server but not its user's cap is passed over, along with its
  // user's later waiters, so each user's uploads still go in order.
  private pump(): void {
    const held = new Set<string>();
    for (let i = 0; i < this.waiting.length; ) {
      const w = this.waiting[i]!;
      if (held.has(w.user)) {
        i++;
      } else if (this.inFlight + w.bytes > this.total) {
        return;
      } else if (!this.fits(w.user, w.bytes)) {
        held.add(w.user);
        i++;
      } else {
        this.waiting.splice(i, 1);
        w.grant();
      }
    }
  }

  private take(user: string, bytes: number): () => void {
    this.inFlight += bytes;
    this.byUser.set(user, (this.byUser.get(user) ?? 0) + bytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= bytes;
      const left = this.byUser.get(user)! - bytes;
      if (left) this.byUser.set(user, left);
      else this.byUser.delete(user);
      this.pump();
    };
  }
}

// Reads an upload's body of the declared `length`, failing once `ms` passes,
// so a client that trickles bytes can't hold its reservation for long. The
// body is cancelled on the way out, which ends the request's read.
export async function readUploadBody(req: Request, length: number, ms: number): Promise<Uint8Array> {
  const data = new Uint8Array(length);
  if (!req.body) return data.subarray(0, 0);
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UploadTimeout(ms)), ms);
  });
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) return data.subarray(0, got);
      if (got + value.length > length) throw new CoreError("the body is longer than its Content-Length");
      data.set(value, got);
      got += value.length;
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export class UploadTimeout extends Error {
  constructor(ms: number) {
    super(`the upload's body didn't arrive within ${Math.round(ms / 1000)}s`);
  }
}
