import type { Repo } from "../../src/server/db.ts";

type Reads = Repo["oauth"];

// Replaces an auth hot-path read on `repo.oauth`, which every token check reaches (#807 P3 A7d2c). `wrap` gets the
// original and returns the replacement. Returns the restore.
// `repo.authPeek` answers from the access cache directly, for the stream timer's phase A and a pooled request's
// authentication (#1627), so a stubbed findActiveAccess also makes its token lookups miss: every check then reaches
// the stub, phase A deferring each stream to phase B's full check.
export function stubAuthRead<K extends "findActiveAccess" | "isGrantActive">(repo: Repo, key: K, wrap: (original: Reads[K]) => Reads[K]): () => void {
  const original = repo.oauth[key], authPeek = repo.authPeek;
  repo.oauth[key] = wrap(original);
  if (key === "findActiveAccess") repo.authPeek = () => { const p = authPeek(); return p && { ...p, access: () => undefined }; };
  return () => { repo.oauth[key] = original; repo.authPeek = authPeek; };
}
