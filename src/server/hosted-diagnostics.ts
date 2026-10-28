import { errorDiagnostic } from "./diagnostics.ts";

type Operation = "oauth.sweep" | "oauth.exchange" | "oauth.request" | "oauth.replay" | "delivery.changed" | "delivery.closed" | "resources.changed" | "resources.closed" | "resources.finish" | "resources.authorize" | "hosted.sweep" | "mcp.hint" | "mcp.binding" | "mcp.stream" | "mcp.resource" | "mcp.subscriber";

// Deliberately accepts no request-derived strings; an error contributes only its class and an allowlisted code.
export function hostedFailure(operation: Operation | "mcp.legacy" | "rate_limit.end", error?: unknown, level: "error" | "warning" = "error") {
  console[level === "warning" ? "warn" : "error"](`[grayboard] ${JSON.stringify({ operation, category: "failure", level, ...errorDiagnostic(error) })}`);
}
