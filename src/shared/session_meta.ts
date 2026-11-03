// The `_meta` keys a generic-key client (#414, #429) sends with every request:
// its raw session id, and beside it its declared delivery. The server reads
// them (src/server/oauth-config.ts, src/server/hosted.ts); hosted-core's
// client.ts sends them. OpenCode's client keeps its own key
// (OPENCODE_SESSION_META).
export const GRAYBOARD_SESSION_META = "io.github.nolnoch.grayboard/sessionID";
export const GRAYBOARD_DELIVERY_META = "io.github.nolnoch.grayboard/delivery";
// Beside the session key, a poll root's tools-only declaration (#451): the alias it writes as. It holds nothing and
// binds nothing; a request whose declaration disagrees with the session's is refused.
export const GRAYBOARD_WRITES_AS_META = "io.github.nolnoch.grayboard/writes_as";
// On a native tool result, not a request (#453): the result carries an alias_lost notice, so the root's holds
// changed and a host that caches the session's instructions (hosted-core's proxy) fetches them again.
export const GRAYBOARD_ALIAS_LOST_META = "io.github.nolnoch.grayboard/alias_lost";
// Beside the session key, the harness's current model and effort (#364), one line each. A client sends them on its
// native requests whenever it knows them and never clears one by omitting it; the server keeps the latest as the
// session's `ids.model`/`ids.effort`, which peer_list shows and match:{model, effort} filters on.
export const GRAYBOARD_MODEL_META = "io.github.nolnoch.grayboard/model";
export const GRAYBOARD_EFFORT_META = "io.github.nolnoch.grayboard/effort";
