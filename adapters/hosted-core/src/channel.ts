// The one `<channel>` renderer for adapter-owned push (pi, omp, Claude Code):
// the shape Claude Code shows the model for a channel notification, so the
// server's instructions apply alike in every harness. Content and meta are
// the server's inbox items as core builds them (dmNotification and
// boardNotification, src/shared/notifications.ts). OpenCode keeps its own JSON
// admission.
import { InboxEvent, isOwnHuman } from "./own-human.js";
import { boardNotification, dmNotification, type DirectNotice, type Pending } from "../../../src/shared/notifications.ts";
import type { Identity, Item } from "./model.js";

export type ChannelParams = { content: string; meta?: Record<string, string> };


// The channel params core builds for an inbox item, with human="true" on
// what the user's own human (`<email>/human`, the Slack bridge) sent. Throws
// on an event that isn't the server's inbox shape.
export function channelParams(item: Item, identity: Identity): { content: string; meta: Record<string, string> } {
  const event = InboxEvent.parse(item.event);
  if (event.kind === "direct") {
    // Validated above for what is read here; the server built the rest as core's DirectNotice.
    const params = dmNotification(event.message as unknown as DirectNotice, identity.identity_full);
    if (isOwnHuman(event, identity)) params.meta.human = "true";
    return params;
  }
  // Same: core's Pending, as the server queued it.
  const params = boardNotification(event.item as unknown as Pending);
  if (isOwnHuman(event, identity)) params.meta.human = "true";
  return params;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// A body can't open or close a channel element (#433): the `<` of any
// `<channel` or `</channel` in the content, any case and spacing, becomes
// `&lt;`, so a peer can't forge an element with its own attributes
// (`human="true"`). Every other character stays as sent.
export function render({ content, meta = {} }: ChannelParams, source: string): string {
  const attrs = Object.entries(meta).map(([key, value]) => ` ${key}="${escape(value)}"`).join("");
  return `<channel source="${escape(source)}"${attrs}>\n${content.replace(/<(?=\s*\/?\s*channel)/gi, "&lt;")}\n</channel>`;
}

// Whether the host wakes the agent for an item: an actionable one does
// (direct messages, mentions, thread replies); a digest or a deferred thread
// reply never does, it is context for the next turn.
export function wakes(actionable: boolean, meta: Record<string, string> = {}): boolean {
  return actionable && meta.kind !== "digest" && meta.deferred !== "true";
}
