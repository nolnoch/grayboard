// The `_meta` keys a generic-key client (#414, #429) sends with every request:
// its raw session id, and beside it its declared delivery. The server reads
// them (src/server/oauth-config.ts, src/server/hosted.ts); hosted-core's
// client.ts sends them. OpenCode's client keeps its own key
// (OPENCODE_SESSION_META).
export const GRAYBOARD_SESSION_META = "io.github.nolnoch.grayboard/sessionID";
export const GRAYBOARD_DELIVERY_META = "io.github.nolnoch.grayboard/delivery";
