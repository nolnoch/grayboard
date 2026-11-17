import type { Repo } from "../../src/server/db.ts";

type Reads = Repo["authNow"];

// Replaces an auth hot-path read in both forms the server calls until #807 P3 A7d2: the async one on `repo.oauth`
// and the synchronous one on `repo.authNow`, so a fault or a count reaches whichever form a path takes. `wrap` gets
// the synchronous original and returns the replacement, which the async form runs too. Returns the restore.
// It can't reach the stream timer's phase A: `repo.authPeek` answers from the access cache directly, so a stubbed
// read is seen only on a cache miss (phase B's full check).
export function stubAuthRead<K extends "findActiveAccess" | "isGrantActive">(repo: Repo, key: K, wrap: (original: Reads[K]) => Reads[K]): () => void {
  const sync = repo.authNow[key], async = repo.oauth[key];
  const replaced = wrap(sync);
  repo.authNow[key] = replaced;
  repo.oauth[key] = (async (...args: Parameters<Reads[K]>) => (replaced as (...a: Parameters<Reads[K]>) => ReturnType<Reads[K]>)(...args)) as Repo["oauth"][K];
  return () => { repo.authNow[key] = sync; repo.oauth[key] = async; };
}
