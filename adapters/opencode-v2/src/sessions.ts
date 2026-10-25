export type SessionNode = { id: string; parentID?: string; time: { archived?: number } };
export type SessionPath = { sessionID: string; root: string; via: string[] };
export class AncestryError extends Error {}

export async function resolveRoot(sessionID: string, get: (id: string) => Promise<SessionNode>): Promise<SessionPath> {
  const visited = new Set<string>();
  const ancestors: string[] = [];
  let current = sessionID;
  for (let step = 0; step < 16; step++) {
    if (visited.has(current)) throw new AncestryError(`Grayboard ancestry repeats ${current} at step ${step + 1}`);
    visited.add(current);
    let session: SessionNode;
    try { session = await get(current); }
    catch { throw new AncestryError(`Grayboard ancestry missing ${current} at step ${step + 1}`); }
    if (!session || session.id !== current || session.time.archived) throw new AncestryError(`Grayboard ancestry inactive ${current} at step ${step + 1}`);
    if (!session.parentID) return { sessionID, root: current, via: ancestors };
    if (current !== sessionID) ancestors.push(current);
    current = session.parentID;
  }
  throw new AncestryError(`Grayboard ancestry exceeds 16 steps from ${sessionID}`);
}

// Retain routing after OpenCode removes the session; deletion events carry only its ID.
export class SessionRoutes {
  private readonly paths = new Map<string, SessionPath>();
  private readonly ended = new Set<string>();
  remember(path: SessionPath) {
    if (this.ended.has(path.sessionID) || this.ended.has(path.root)) throw new AncestryError("Grayboard session ended during ancestry lookup");
    const previous = this.paths.get(path.sessionID);
    if (previous && previous.root !== path.root) throw new AncestryError("Grayboard session ancestry changed");
    this.paths.set(path.sessionID, { ...path, via: [...path.via] });
  }
  end(sessionID: string): SessionPath | undefined {
    if (this.ended.has(sessionID)) return;
    this.ended.add(sessionID);
    const path = this.paths.get(sessionID);
    this.paths.delete(sessionID);
    return path ? { ...path, via: [...path.via] } : undefined;
  }
}
