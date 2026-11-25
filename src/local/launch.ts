// How `grayboard mcp` was launched, set by the CLI before it imports
// `./mcp.ts` (which starts on import).
// `modePinned`: the entry passed `--mode local`, the explicit choice of the
// local bus on a machine signed in to a server (#491).
export const launch = { modePinned: false };
