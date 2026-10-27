// The producer boundary must cover every controlled delivery, not just entry into synthetic().
export async function afterProducers(producers: () => Promise<void>, drain: () => Promise<unknown>, check: () => void) {
  await producers();
  await drain();
  check();
}
