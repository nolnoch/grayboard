const failureSources = {
  "hosted-tool": { source: "src/server/mcp.ts", operation: "tool" },
  "hosted-factory": { source: "src/server/mcp.ts", operation: "factory" },
  "hosted-admission": { source: "src/server/mcp.ts", operation: "admission" },
  "hosted-fetch": { source: "src/server/mcp.ts", operation: "fetch" },
  "hosted-sdk": { source: "src/server/mcp.ts", operation: "sdk" },
  "slack-bus": { source: "src/server/slack.ts", operation: "bus.call" },
} as const;
export type FailureSource = keyof typeof failureSources;

// Stack text includes multiline messages and can be forged, even for real filenames.
// Derive provenance from the catch site only; never inspect errors or their causes.
export function failureDiagnostic(source: FailureSource) {
  const context = typeof source === "string" && Object.hasOwn(failureSources, source)
    ? failureSources[source] : { source: "server", operation: "unknown" };
  return { ...context, category: "unexpected" };
}

export function diagnosticOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : "[invalid origin]";
  } catch { return "[invalid origin]"; }
}
