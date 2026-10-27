// Error messages and properties can contain SQL values, credentials or tool input.
// Keep only source locations, including those of chained causes.
export function failureLocations(error: unknown): string[] {
  const locations: string[] = [];
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error) && seen.size < 4) {
    seen.add(error);
    for (const line of (error.stack ?? "").split("\n").slice(1)) {
      if (/https?:\/\//i.test(line)) continue;
      const match = line.match(/[/\\]([\w.-]+\.[cm]?[jt]s):([0-9]+):([0-9]+)\)?$/);
      if (match) locations.push(`${match[1]}:${match[2]}:${match[3]}`);
      if (locations.length >= 12) return locations;
    }
    error = error.cause;
  }
  return locations;
}

export function diagnosticOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : "[invalid origin]";
  } catch { return "[invalid origin]"; }
}
