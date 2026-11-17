// Waits for every promise, then rejects with the first rejection in argument order, if any. Unlike Promise.all, a
// failure doesn't settle it while another write it was queued with is still in flight: a caller that closes the
// database once this settles would otherwise close it under that write.
export async function settleAll(promises: readonly Promise<unknown>[]): Promise<void> {
  const failure = (await Promise.allSettled(promises)).find(outcome => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
