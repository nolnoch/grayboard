type Operation = "oauth.sweep" | "oauth.exchange" | "oauth.request" | "oauth.replay" | "delivery.changed" | "delivery.closed" | "resources.changed" | "resources.closed" | "resources.finish" | "resources.authorize" | "hosted.sweep" | "mcp.hint" | "mcp.binding" | "mcp.stream" | "mcp.resource" | "mcp.subscriber";

// Deliberately accepts no exception or request-derived strings.
export function hostedFailure(operation: Operation | "mcp.legacy" | "rate_limit.end", level: "error" | "warning" = "error") {
  console[level === "warning" ? "warn" : "error"](`[grayboard] ${JSON.stringify({ operation, category: "failure", level })}`);
}
