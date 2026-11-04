// A sign-in flow's bound, the browser round trip's: hosted-core's flow
// (adapters/hosted-core/src/login.ts) gives up past it, and the Claude Code
// hook (claude_agents.ts) shows no link older than it (#500). Its own module
// because the hook can't load login.ts (zod, node:http) and must stay light.
export const SIGN_IN_FLOW_MS = 10 * 60_000;
