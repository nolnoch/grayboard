// Errors a caller can show as-is: a refused tool call, not a fault. Kept out
// of boards.ts so src/shared/ and core/attachments.ts can throw them without
// importing the board store.
export class CoreError extends Error {}

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
