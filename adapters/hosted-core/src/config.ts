// A hosted adapter's server config: `<stateDir>/config.json {url}`, written by
// `grayboard setup --server` (src/cli/main.ts) and read by the adapter at
// session start. This module is the one definition of its path and shape.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalEndpoint } from "../../../src/shared/endpoint.ts";

export const HostedConfig = z.object({ url: z.string().min(1) });
export type HostedConfig = z.infer<typeof HostedConfig>;

export const hostedConfigPath = (stateDir: string): string => join(stateDir, "config.json");

// Login and the tool proxy refuse a URL that isn't canonical; refusing it here
// instead keeps the adapter loading (pi exits at startup when one fails).
export function readHostedConfig(stateDir: string): HostedConfig | { error: string } {
  const unset = "grayboard is not set up for a server; run `grayboard setup --server <url>`";
  const path = hostedConfigPath(stateDir);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { return { error: error instanceof Error && "code" in error && error.code === "ENOENT" ? unset : `${unset} (${String(error)})` }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {}
  const config = HostedConfig.safeParse(parsed);
  if (!config.success) return { error: `${path} is invalid; run \`grayboard setup --server <url>\`` };
  // The URL itself stays out of the message: it may carry credentials.
  if (!canonicalEndpoint(config.data.url)) return { error: `${path} names a server URL that isn't canonical HTTPS (or HTTP loopback) without credentials, query or fragment; run \`grayboard setup --server <url>\` with one that is` };
  return { url: config.data.url };
}
