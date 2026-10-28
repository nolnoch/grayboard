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
// Derive provenance from the catch site only; never read messages, stacks or causes.
export function failureDiagnostic(source: FailureSource, error?: unknown) {
  const context = typeof source === "string" && Object.hasOwn(failureSources, source)
    ? failureSources[source] : { source: "server", operation: "unknown" };
  return { ...context, category: "unexpected", ...errorDiagnostic(error) };
}

const errorClass = /^([A-Z][A-Za-z0-9]{0,55})?(Error|Exception)$/;
const errorCode = /^(SQLITE_[A-Z_]{1,48}|E[A-Z]{2,15})$/;

// The error's class and an allowlisted code (SQLite or errno), read from data
// descriptors only: no getter, trap or toString runs, and nothing free-form leaves.
export function errorDiagnostic(error: unknown): { class?: string; code?: string } {
  if (error === undefined) return {};
  try {
    if (typeof error !== "object" || error === null || !(error instanceof Error)) return { class: "non-error" };
    let name: unknown;
    for (let o: object | null = error, n = 0; o && n < 8 && name === undefined; o = Object.getPrototypeOf(o), n++) {
      name = Object.getOwnPropertyDescriptor(o, "name")?.value;
    }
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return {
      class: typeof name === "string" && errorClass.test(name) ? name : "[unrecognized]",
      ...(typeof code === "string" && errorCode.test(code) ? { code } : {}),
    };
  } catch { return { class: "[unrecognized]" }; }
}

export function diagnosticOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : "[invalid origin]";
  } catch { return "[invalid origin]"; }
}
