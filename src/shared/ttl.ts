const MAX_TTL_MS = 7 * 86_400_000;

/** "45m", "2h", "3d" → milliseconds; at most 7 days. */
export function parseTtl(text: string): number {
  const m = /^(\d+)\s*([mhd])$/i.exec(text.trim());
  const ms = m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "m" | "h" | "d"] : 0;
  if (!(ms > 0) || ms > MAX_TTL_MS) throw new Error(`--ttl must be like 45m, 2h or 3d, at most 7d; got "${text}"`);
  return ms;
}
