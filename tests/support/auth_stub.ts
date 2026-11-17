import type { Repo } from "../../src/server/db.ts";

type Reads = Repo["oauth"];

// Replaces an auth hot-path read on `repo.oauth`, which every token check reaches (#807 P3 A7d2c). `wrap` gets the
// original and returns the replacement. Returns the restore.
// It can't reach the stream timer's phase A: `repo.authPeek` answers from the access cache directly, so a stubbed
// read is seen only on a cache miss (phase B's full check).
export function stubAuthRead<K extends "findActiveAccess" | "isGrantActive">(repo: Repo, key: K, wrap: (original: Reads[K]) => Reads[K]): () => void {
  const original = repo.oauth[key];
  repo.oauth[key] = wrap(original);
  return () => { repo.oauth[key] = original; };
}
