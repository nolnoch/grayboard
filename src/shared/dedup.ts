// How long a repeat of an append write (dm_send, board_post, delegate) is
// answered with the first result (#254). It must outlast a harness's answer
// timeout plus the model's next turn; a wider window swallows more deliberate
// repeats. A leaf module: core, the plugin and the server all read it.
export const WRITE_DEDUP_WINDOW_MS = 10 * 60_000;
export const WRITE_DEDUP_WINDOW_TEXT = `${WRITE_DEDUP_WINDOW_MS / 60_000} minutes`;
