// Errors a caller can show as-is: a refused tool call, not a fault. Kept out
// of boards.ts so src/shared/ and core/attachments.ts can throw them without
// importing the board store.
export class CoreError extends Error {}

/** A file, a message's files, or a user's unsent uploads over a size cap (HTTP 413). */
export class TooLargeError extends CoreError {}
