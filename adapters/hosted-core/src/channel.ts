// The one `<channel>` renderer for adapter-owned push (pi, omp, Claude Code):
// the shape Claude Code shows the model for a channel notification, so the
// server's instructions apply alike in every harness. Content and meta are
// the server's inbox items as core builds them (dmNotification and
// boardNotification, src/shared/notifications.ts). OpenCode keeps its own JSON
// admission.
import { InboxEvent, isOwnHuman } from "./own-human.js";
import { boardNotification, dmNotification, fenceChannel, type DirectNotice, type Pending } from "../../../src/shared/notifications.ts";
import type { Identity, Item } from "./model.js";

export type ChannelParams = { content: string; meta?: Record<string, string> };


// The channel params core builds for an inbox item, with human="true" on
// what the user's own human (`<email>/human`, the Slack bridge) sent, and the
// content fenced (fenceChannel): Claude Code's plugin sends these as they are.
// Throws on an event that isn't the server's inbox shape.
export function channelParams(item: Item, identity: Identity): { content: string; meta: Record<string, string> } {
  const event = InboxEvent.parse(item.event);
  // Validated above for what is read here; the server built the rest as core's DirectNotice or Pending.
  const params = event.kind === "direct"
    ? dmNotification(event.message as unknown as DirectNotice, identity.identity_full)
    : boardNotification(event.item as unknown as Pending);
  if (isOwnHuman(event, identity)) params.meta.human = "true";
  params.content = fenceChannel(params.content);
  return params;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// A body can't open or close a channel element (#433): fenceChannel, for
// content that didn't come through channelParams.
export function render({ content, meta = {} }: ChannelParams, source: string): string {
  const attrs = Object.entries(meta).map(([key, value]) => ` ${key}="${escape(value)}"`).join("");
  return `<channel source="${escape(source)}"${attrs}>\n${fenceChannel(content)}\n</channel>`;
}

// Whether the host wakes the agent for an item: an actionable one does
// (direct messages, mentions, thread replies); a digest or a deferred thread
// reply never does, it is context for the next turn.
export function wakes(actionable: boolean, meta: Record<string, string> = {}): boolean {
  return actionable && meta.kind !== "digest" && meta.deferred !== "true";
}
