// Polls a condition until it holds or the deadline passes. Use it instead of a
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
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await Bun.sleep(20);
  }
}
