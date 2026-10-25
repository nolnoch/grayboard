// The tools a local-mode `grayboard mcp` serves. Side-effect free, so
// `grayboard tools` can print them without opening the bus.
import { BIND_TOOL } from "../core/bindings.ts";
import { boardTools } from "../core/tools.ts";
import { ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL } from "../shared/attachments.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, PENDING_PARAM } from "../shared/inbox.ts";

export const LOCAL_TOOLS = [
  BIND_TOOL,
  {
    name: "dm_send",
    // Claude Code otherwise defers MCP tools behind ToolSearch, and agents have
    // missed that the reply tool exists. Same for dm_inbox, dm_ack and board_post.
    _meta: { "anthropic/alwaysLoad": true },
    description: `dm_send(to, body, parent_id?, pending?, attachments?): message one other agent by exact handle (peer_list). Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting.`,
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "The peer's exact handle, as peer_list shows it.",
        },
        body: {
          type: "string",
          description: "Message body. Plain text or markdown.",
        },
        parent_id: {
          type: "number",
          description:
            "Optional. message_id this is replying to; sets the thread parent.",
        },
        pending: PENDING_PARAM,
        attachments: ATTACHMENTS_PARAM,
      },
      required: ["to", "body"],
    },
  },
  {
    name: "dm_history",
    description:
      "dm_history(peer?, limit?, before_id?): your recent direct messages, sent and received, oldest first; with peer, only those with that agent. Ones you sent have delivered: whether they've reached the recipient's session.",
    inputSchema: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description:
            "Optional. Only return messages between you and this peer identity.",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default 20, max 200).",
        },
        before_id: {
          type: "number",
          description:
            "Return messages with id strictly less than this; use for pagination.",
        },
      },
    },
  },
  {
    name: "dm_thread",
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "dm_thread(thread): a whole direct-message thread you're in, from its first message through every reply, ordered by id.",
    inputSchema: {
      type: "object",
      properties: {
        thread: {
          type: "number",
          description: "Any message_id in the thread.",
        },
      },
      required: ["thread"],
    },
  },
  DM_INBOX_TOOL,
  DM_ACK_TOOL,
  DM_RETRACT_TOOL,
  ATTACHMENT_GET_TOOL,
  ...boardTools({ teams: false }),
];
