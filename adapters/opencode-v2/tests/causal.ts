// The producer boundary must cover every controlled delivery, not just entry into synthetic().
export async function afterProducers(producers: () => Promise<void>, drain: () => Promise<unknown>, check: () => void) {
  await producers();
  await drain();
  check();
}

export function rootStatus<T extends { sessionID?: string }>(status: { roots: readonly T[] }, sessionID: string): T | undefined {
  return status.roots.find(root => root.sessionID === sessionID);
}

export function rootRetrying(status: { roots: readonly { sessionID?: string; state: string; operation: string; code?: string }[] }, sessionID: string): boolean {
  const root = rootStatus(status, sessionID);
  return root?.state === "retrying" && root.operation === "reopen" && root.code === "operation_failed";
}
