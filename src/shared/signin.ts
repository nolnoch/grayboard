// A sign-in flow's bound and its link's shape, shared by hosted-core's flow
// (adapters/hosted-core/src/login.ts), the offer module (offer.ts) and the
// Claude Code hook (claude_agents.ts, #500). Its own module because the hook
// can't load login.ts (zod, node:http) and must stay light.
import { LOOPBACK } from "./endpoint.ts";

// The browser round trip's bound: the flow gives up past it, and the hook
// shows no link older than it.
export const SIGN_IN_FLOW_MS = 10 * 60_000;
// The longest link shown: canonicalEndpoint's bound (endpoint.ts).
export const SIGN_IN_URL_MAX = 2048;

/**
 * Whether `text` has an authorization URL's shape: at most SIGN_IN_URL_MAX
 * long, no credentials, HTTPS (or HTTP on loopback). Returns the parsed URL,
 * or the check it failed, which never quotes the text.
 */
export function signInUrl(text: string): { url: URL } | { failed: string } {
  if (text.length > SIGN_IN_URL_MAX) return { failed: `longer than ${SIGN_IN_URL_MAX}` };
  let url: URL;
  try { url = new URL(text); } catch { return { failed: "not a URL" }; }
  if (url.username || url.password) return { failed: "carries credentials" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return { failed: "neither HTTPS nor loopback HTTP" };
  return { url };
}
