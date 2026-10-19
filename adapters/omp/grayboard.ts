// grayboard push adapter for omp (oh-my-pi).
//
// omp runs the grayboard MCP server for tools like any MCP client, and
// forwards every server notification to extensions as `mcp_notification`.
// This bridges grayboard's channel events into the session, so the MCP server
// stays the single owner of the wakeup socket and read cursors.
//
// Install: copy or symlink into ~/.omp/agent/extensions/ (or <repo>/.omp/extensions/),
// or run `omp -e /path/to/grayboard/adapters/omp/grayboard.ts`.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type ChannelParams = { content: string; meta?: Record<string, string> };

const SERVER = process.env.GRAYBOARD_MCP_NAME ?? "grayboard";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Same shape Claude Code shows the model, so the MCP server's instructions apply.
function render({ content, meta = {} }: ChannelParams): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<channel source="grayboard"${attrs}>\n${content}\n</channel>`;
}

export default function grayboard(pi: ExtensionAPI) {
  pi.on("mcp_notification", (event) => {
    if (event.server !== SERVER || event.method !== "notifications/claude/channel") return;
    const params = event.params as ChannelParams;
    const contextOnly = params.meta?.kind === "digest" || params.meta?.deferred === "true";
    pi.sendMessage(
      {
        customType: "grayboard",
        content: render(params),
        display: true,
        attribution: "agent",
      },
      // Direct messages, mentions, thread replies: act on them (wakes an idle
      // agent; mid-run, lands at the next step boundary). Digests and deferred
      // thread replies: context only.
      contextOnly ? { deliverAs: "nextTurn" } : { deliverAs: "aside", triggerTurn: true },
    );
  });
}
