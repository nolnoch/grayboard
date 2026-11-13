// OpenCode's human root approval: the saved enrollment lives in the root
// session's metadata, fingerprinted in plugin storage so an edited record can
// never manufacture approval on restore. Each root's fingerprint is its own
// record (`enrollmentHash:<sessionID>`), and restore finds the saved roots by
// scanning that prefix: there is no shared root list for one OpenCode location
// to overwrite with its own (#660).
import { createHash } from "node:crypto";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ApprovalPort, Enrollment } from "./core/port.js";
import { same } from "./core/model.js";

export const METADATA = "grayboard.enrollment";
const HASH = "enrollmentHash:";
export type OpenCodeEnrollment = Enrollment & { mcpName: string; integrationID: string; connectionID: string };
export function enrollmentHash(e: OpenCodeEnrollment) {
  const c = e.configuration;
  return createHash("sha256").update(JSON.stringify([e.version, e.sessionID, e.mcpName, c.type, c.url, c.issuer, c.clientID, c.scope, c.configHash, e.integrationID, e.connectionID, e.held ?? []])).digest("hex");
}
type Saved = { enabled?: boolean; enrollment?: OpenCodeEnrollment } | undefined;

export class Approval implements ApprovalPort<OpenCodeEnrollment> {
  constructor(readonly ctx: Context, readonly mcpName: string) {}
  key(e: OpenCodeEnrollment) { return enrollmentHash(e); }
  private async metadata(sessionID: string) {
    const session = await this.ctx.session.get({ sessionID });
    return { session, saved: session.metadata?.[METADATA] as Saved };
  }
  async save(e: OpenCodeEnrollment, approval: OpenCodeEnrollment, enabled: boolean) {
    const { session } = await this.metadata(e.sessionID);
    await this.ctx.session.update({ sessionID: session.id, metadata: { ...session.metadata, [METADATA]: { enabled, enrollment: approval } } });
    await this.ctx.storage.set(HASH + session.id, enrollmentHash(approval));
  }
  async drop(sessionID: string) { await this.ctx.storage.remove(HASH + sessionID); }
  async approved(e: OpenCodeEnrollment, approval: OpenCodeEnrollment) {
    const { saved } = await this.metadata(e.sessionID);
    return !!saved?.enabled && same(saved.enrollment, approval);
  }
  async saved() {
    const hashes = new Map<string, unknown>();
    let after: string | undefined;
    do {
      const page = await this.ctx.storage.scan({ prefix: HASH, ...(after === undefined ? {} : { after }) });
      for (const entry of page.entries) hashes.set(entry.key.slice(HASH.length), entry.value);
      after = page.next;
    } while (after !== undefined);
    const result: Array<{ sessionID: string; approval: OpenCodeEnrollment | null; enabled: boolean }> = [];
    for (const [id, hash] of hashes) {
      let saved: Saved;
      try { saved = (await this.metadata(id)).saved; }
      catch { result.push({ sessionID: id, approval: null, enabled: false }); continue; }
      const e = saved?.enrollment;
      const valid = !!e && e.version === 2 && e.sessionID === id && e.mcpName === this.mcpName && hash === enrollmentHash(e);
      result.push({ sessionID: id, approval: valid ? e! : null, enabled: !!saved?.enabled });
    }
    return result;
  }
}
