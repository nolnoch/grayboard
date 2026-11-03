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
// Beside the session key, the name the client's checkout suggests (#443): the unbound candidates offer it first. A
// bare identity name; the server keeps the first request's for the session's life and ignores later ones.
export const GRAYBOARD_SUGGESTED_META = "io.github.nolnoch.grayboard/suggested";
// Beside the session key, a launcher declaration (#473): `true` says this session's harness can spawn subagents, the
// hosted counterpart of a local session's BUS_LAUNCHER=1. It is stated when an ownership starts and kept until it
// ends (`ids.launcher`); a later request's value is not read, and anything but a boolean is refused.
export const GRAYBOARD_LAUNCHER_META = "io.github.nolnoch.grayboard/launcher";
// Local mode only (#523): on a tool call to `grayboard mcp`, the raw ID of the harness subagent making it, so the
// call is that subagent's child session, acting under this session's addresses (src/local/mcp.ts). A separate key
// from GRAYBOARD_SESSION_META, whose presence means "this session". Harness-asserted: it grants nothing beyond the
// root's powers, and only attributes the write (`via`).
export const GRAYBOARD_AGENT_META = "io.github.nolnoch.grayboard/agent";

/** A harness-asserted raw session ID as every mode accepts one: 1–1024 characters, no control characters. */
export function validSourceId(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 1024 && !/[\x00-\x1f\x7f]/.test(raw);
}
