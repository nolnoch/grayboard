// The opencode-v2 tests' one wait helper, the same as tests/support/until.ts: the host scripts copy
// these tests into scratch directories, where an import from the repo root would not resolve (#571).
// Polls a condition until it returns a truthy value, or the deadline passes. Use it instead of a
// fixed sleep (#94). The timeout names what it waited for: `what`, or the
// condition's own source when no label is given.
export async function until<T>(
  f: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  ms = 5000,
  what: string = f.toString(),
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await Bun.sleep(20);
  }
}
