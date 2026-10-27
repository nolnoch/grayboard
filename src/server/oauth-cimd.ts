import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { OAUTH_SCOPES, validateRedirect, type OAuthClient } from "./oauth-config.ts";

export class CimdUnavailable extends Error {
  constructor() { super("CIMD temporarily unavailable"); }
}
class InvalidMetadata extends Error {}

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix);
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6 || !/^[23][0-9a-f]{0,3}:/i.test(address)) return false;
  return !blocked.check(address, "ipv6");
}
function metadataUrl(id: string): URL {
  if (id.length > 512 || /[\x00-\x20\x7f\\]/.test(id)) throw new Error("invalid CIMD identifier");
  const u = new URL(id);
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search || u.port || u.href !== id || isIP(u.hostname.replace(/^\[|\]$/g, "")) || !u.hostname.includes(".") || u.hostname.endsWith(".")) throw new Error("invalid CIMD identifier");
  return u;
}
type Address = { address: string; family: number };
export type CimdOptions = {
  now?: () => number;
  resolve?: (host: string) => Promise<Address[]>;
  // Trusted test seam; production always uses the pinned TLS connection below.
  read?: (url: URL, address: Address, signal: AbortSignal) => Promise<string>;
};
function readPinned(url: URL, address: Address, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, signal, lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family), headers: { Accept: "application/json" } }, response => {
      if ((response.statusCode ?? 500) >= 500 || response.statusCode === 429) { response.destroy(); reject(new CimdUnavailable()); return; }
      if (response.statusCode !== 200 || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(response.headers["content-type"] ?? "")) { response.destroy(); reject(new InvalidMetadata("invalid CIMD response")); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 32_768) { response.destroy(new InvalidMetadata("CIMD document too large")); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { reject(new InvalidMetadata("invalid UTF-8")); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}
export function parseCimd(id: string, text: string): OAuthClient {
  if (Buffer.byteLength(text) > 32_768) throw new Error("CIMD document too large");
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v) || v.client_id !== id || typeof v.client_name !== "string" || !v.client_name.trim() || v.client_name.length > 200 || /[\x00-\x1f\x7f]/.test(v.client_name) || v.token_endpoint_auth_method !== "none" || !Array.isArray(v.redirect_uris) || v.redirect_uris.length < 1 || v.redirect_uris.length > 16 || new Set(v.redirect_uris).size !== v.redirect_uris.length) throw new Error("invalid CIMD metadata");
  for (const uri of v.redirect_uris) validateRedirect(uri);
  if (v.grant_types !== undefined && (!Array.isArray(v.grant_types) || !v.grant_types.includes("authorization_code") || v.grant_types.some((s: unknown) => !["authorization_code", "refresh_token"].includes(String(s))))) throw new Error("invalid CIMD grants");
  if (v.response_types !== undefined && (!Array.isArray(v.response_types) || v.response_types.length !== 1 || v.response_types[0] !== "code")) throw new Error("invalid CIMD response types");
  return { clientId: id, name: v.client_name, redirectUris: [...v.redirect_uris], scopes: [...OAUTH_SCOPES], tokenEndpointAuthMethod: "none", allowRefresh: v.grant_types === undefined || v.grant_types.includes("refresh_token") };
}
export function createCimdResolver(options: CimdOptions = {}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { until: number; client: OAuthClient }>();
  const failures = new Map<string, { until: number; transient: boolean }>();
  const pending = new Map<string, Promise<OAuthClient | undefined>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  return {
    async resolve(id: string): Promise<OAuthClient | undefined> {
      if (closed) return;
      let url: URL;
      try { url = metadataUrl(id); } catch { return; }
      for (const [key, item] of cache) if (item.until <= now()) cache.delete(key);
      for (const [key, item] of failures) if (item.until <= now()) failures.delete(key);
      const cached = cache.get(id);
      if (cached) return cached.client;
      const failure = failures.get(id);
      if (failure?.transient) throw new CimdUnavailable();
      if (failure) return;
      const inflight = pending.get(id);
      if (inflight) return inflight;
      if (pending.size >= 8 || cache.size + pending.size >= 128) throw new CimdUnavailable();
      const controller = new AbortController();
      controllers.add(controller);
      let timer: ReturnType<typeof setTimeout>;
      const work = (async () => {
        try {
          const load = async () => {
            const addresses = await (options.resolve ?? (host => lookup(host, { all: true, verbatim: true })))(url.hostname);
            if (!addresses.length) throw new CimdUnavailable();
            if (addresses.length > 32 || addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new InvalidMetadata("unsafe CIMD DNS answer");
            if (controller.signal.aborted) throw new Error("CIMD fetch aborted");
            const text = await (options.read ?? readPinned)(url, addresses[0]!, controller.signal);
            try { return parseCimd(id, text); } catch { throw new InvalidMetadata("invalid CIMD metadata"); }
          };
          const client = await Promise.race([load(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("CIMD timeout")); }, 5000); })]);
          if (closed) return;
          cache.set(id, { until: now() + 300_000, client });
          return client;
        } catch (error) {
          if (closed) return;
          const transient = !(error instanceof InvalidMetadata);
          if (failures.size >= 128) failures.delete(failures.keys().next().value!);
          failures.set(id, { until: now() + 30_000, transient });
          if (transient) throw new CimdUnavailable();
          return undefined;
        } finally { clearTimeout(timer!); controllers.delete(controller); pending.delete(id); }
      })();
      pending.set(id, work);
      return work;
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); cache.clear(); failures.clear(); },
  };
}
