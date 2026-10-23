// Bounds the upload bodies the server holds in memory at once. Each upload
// reserves its declared length before its body is read: within `total` across
// the server and `perUser` for one user. A reservation that doesn't fit waits
// its turn, first come first served, until its request is aborted.
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

  // Grants waiters in order while the first one fits.
  private pump(): void {
    while (this.waiting.length && this.fits(this.waiting[0]!.user, this.waiting[0]!.bytes)) this.waiting.shift()!.grant();
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
