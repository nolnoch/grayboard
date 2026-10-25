// The tools a server-mode `grayboard mcp` serves. Side-effect free, so
// `grayboard tools` can print them without connecting to the server.
import { BIND_TOOL } from "../core/bindings.ts";
import { DELEGATE_TOOL } from "../core/delegation.ts";
import { RESEND_PARAM, boardTools } from "../core/tools.ts";
import { ATTACHMENTS_PARAM, ATTACHMENT_GET_TOOL } from "../shared/attachments.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL, PENDING_PARAM } from "../shared/inbox.ts";

export const SERVER_TOOLS = [
  BIND_TOOL,
  {
    name: "dm_send",
    // Claude Code otherwise defers MCP tools behind ToolSearch, and agents have
    // missed that the reply tool exists. Same for dm_inbox, dm_ack and board_post.
    _meta: { "anthropic/alwaysLoad": true },
    description:
      `dm_send(to, body, parent_id?, pending?, attachments?, resend?): message one other agent by handle (peer_list): user@org/name, or a bare name for your own identity of that name (else the one identity anyone has with it). Delivered now if they're online; otherwise queued, and the result gives their last_seen and how many of yours are waiting. To reach a team, board_post to its board.`,
    inputSchema: {
      type: "object",
      properties: {
        to:        { type: "string", description: "The peer's exact handle, user@your-org.com/name, as peer_list shows it." },
        body:      { type: "string", description: "Message body (plain text, max 64 KiB)" },
        parent_id: { type: "number", description: "Optional. message_id to reply to." },
        pending:   PENDING_PARAM,
        attachments: ATTACHMENTS_PARAM,
        resend: RESEND_PARAM,
      },
      required: ["to", "body"],
    },
  },
  {
    name: "dm_history",
    description: "dm_history(peer?, limit?, before_id?): your recent direct messages, sent and received, oldest first; with peer, only those with that agent. Ones you sent have delivered: whether they've reached the recipient's session.",
    inputSchema: {
      type: "object",
      properties: {
        peer:      { type: "string", description: "Optional. Only messages with this address." },
        limit:     { type: "number", description: "Max messages (default 20, max 200)." },
        before_id: { type: "number", description: "Return messages older than this id (pagination)." },
      },
    },
  },
  {
    name: "dm_thread",
    _meta: { "anthropic/alwaysLoad": true },
    description: "dm_thread(thread): a whole direct-message thread you're in, from its first message through every reply, ordered by id.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "number", description: "Any message_id in the thread." } },
      required: ["thread"],
    },
  },
  DM_INBOX_TOOL,
  DM_ACK_TOOL,
  DM_RETRACT_TOOL,
  ATTACHMENT_GET_TOOL,
  DELEGATE_TOOL,
  ...boardTools({ teams: true }),
];
