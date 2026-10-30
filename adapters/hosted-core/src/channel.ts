// The one `<channel>` renderer for adapter-owned push (pi, omp, Claude Code):
// the shape Claude Code shows the model for a channel notification, so the
// server's instructions apply alike in every harness. Content and meta are
// the server's inbox items as core builds them (dmNotification and
// boardNotification, src/core/tools.ts). OpenCode keeps its own JSON admission.
export type ChannelParams = { content: string; meta?: Record<string, string> };

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
