// Errors a caller can show as-is: a refused tool call, not a fault. Kept out
// of boards.ts so src/shared/ and core/attachments.ts can throw them without
// importing the board store.
export class CoreError extends Error {
  // The wire code a refusal carries when it isn't bad_request (#954): one whose text already names a code.
  constructor(message: string, readonly refusalCode?: "id_collision" | "id_ended" | "child_session") {
    super(message);
  }
}

/** A file, a message's files, or a user's unsent uploads over a size cap (HTTP 413). */
export class TooLargeError extends CoreError {}

/**
 * A BlobStore has no bytes for a sha256 an attachment row names, e.g. swept
 * between the read check and the read. A fault, not a CoreError: the caller
 * reports the file as missing (HTTP 404) and audits it.
 */
export class BlobMissing extends Error {
  constructor(readonly sha256: string) {
    super(`attachment bytes ${sha256} are missing`);
  }
}

/** The refusal for a reply whose parent isn't a post on its board: the post gate's, and the store's backstop (MissingPost). */
export function notAPostText(parentId: number, board: string): string {
  return `parent_id ${parentId} is not a post on #${board}`;
}

/** The id_collision refusal's text, both modes: `id` and why it's taken. */
export function idCollisionText(id: string, why: string): string {
  return `id_collision: ${id} ${why}; start with a new session key`;
}

/** The refusal for a session ID that already has a row (#284 decision 2): a reused key, or a collision. */
export class IdCollision extends CoreError {
  // Why the ID can't be this session's: its id.collision audit's `why`.
  readonly why: string;
  constructor(readonly id: string, readonly endedAt: number | null) {
    const why = endedAt === null ? "is a live session's" : `ended at ${new Date(endedAt).toISOString()}`;
    super(idCollisionText(id, why));
    this.why = why;
  }
}
