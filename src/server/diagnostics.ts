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
// `category`: "unexpected" for a fault; "client_aborted" for a request its client abandoned while it waited (#1535);
// "server_cut" for one the server cut, closing its endpoint or stopping (#1541), or past its deadline (#1591, which adds
// `cut: "deadline"` to the line).
export function failureDiagnostic(source: FailureSource, error?: unknown, category: "unexpected" | "client_aborted" | "server_cut" = "unexpected") {
  const context = typeof source === "string" && Object.hasOwn(failureSources, source)
    ? failureSources[source] : { source: "server", operation: "unknown" };
  return { ...context, category, ...errorDiagnostic(error) };
}

const errorClass = /^([A-Z][A-Za-z0-9]{0,55})?(Error|Exception)$/;
const errorCode = /^(SQLITE_[A-Z_]{1,48}|E[A-Z]{2,15}|ERR_POSTGRES_[A-Z_]{1,40})$/;
// A Postgres SQLSTATE, which Bun.SQL puts in `errno` (a Node system errno is a number).
const sqlstate = /^[0-9A-Z]{5}$/;

// The error's class, an allowlisted code (SQLite, errno or Bun.SQL's) and a SQLSTATE, read from data
// descriptors only: no getter, trap or toString runs, and nothing free-form leaves.
export function errorDiagnostic(error: unknown): { class?: string; code?: string; sqlstate?: string } {
  if (error === undefined) return {};
  try {
    if (typeof error !== "object" || error === null || !(error instanceof Error)) return { class: "non-error" };
    let name: unknown;
    for (let o: object | null = error, n = 0; o && n < 8 && name === undefined; o = Object.getPrototypeOf(o), n++) {
      name = Object.getOwnPropertyDescriptor(o, "name")?.value;
    }
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const errno = Object.getOwnPropertyDescriptor(error, "errno")?.value;
    return {
      class: typeof name === "string" && errorClass.test(name) ? name : "[unrecognized]",
      ...(typeof code === "string" && errorCode.test(code) ? { code } : {}),
      ...(typeof errno === "string" && sqlstate.test(errno) ? { sqlstate: errno } : {}),
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
