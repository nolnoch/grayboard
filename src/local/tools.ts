// The tools a local-mode `grayboard mcp` serves. Side-effect free, so
// `grayboard tools` can print them without opening the bus.
import { BIND_TOOL, UNBIND_TOOL, WHOAMI_TOOL } from "../core/bindings.ts";
import { DELEGATE_TOOL } from "../core/delegation.ts";
import { boardTools, dmTools } from "../core/tools.ts";
import { ATTACHMENT_GET_TOOL } from "../shared/attachments.ts";
import { DM_ACK_TOOL, DM_INBOX_TOOL, DM_RETRACT_TOOL } from "../shared/inbox.ts";

export const LOCAL_TOOLS = [
  BIND_TOOL,
  UNBIND_TOOL,
  WHOAMI_TOOL,
  ...dmTools({ attachments: "paths" }),
  DM_INBOX_TOOL,
  DM_ACK_TOOL,
  DM_RETRACT_TOOL,
  ATTACHMENT_GET_TOOL,
  DELEGATE_TOOL,
  ...boardTools({ teams: false, attachments: "paths" }),
];
