import { barrier } from "./reload-state.js";

// Hold an actual failed transport completion only after the real admission has returned.
export class FailedContinuation {
  private armed = false;
  private forwarded = false;
  private released = false;
  readonly failed = barrier();
  private readonly releaseGate = barrier();
  arm() { this.armed = true; }
  returned() { this.forwarded = true; }
  release() { this.released = true; this.releaseGate.release(); }
  async observe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (this.armed && this.forwarded && !this.released) {
        this.failed.release();
        await this.releaseGate.promise;
      }
      throw error;
    }
  }
}
