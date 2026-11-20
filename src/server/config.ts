import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLoopback, parseOAuthClients, type OAuthClient } from "./oauth-config.ts";
import { parseCimdClients } from "./oauth-cimd.ts";
import { DEFAULT_SERVICE_TOKEN_LIMITS, SERVICE_TOKEN_MIN_SECONDS, type ServiceTokenLimits } from "./oauth-types.ts";

import type { HumanReach } from "./policy.ts";
import { DEFAULT_LAG_GATE, LAG_HISTORY, type LagGate } from "./metrics.ts";
import { DEFAULT_AUTH_FAIL_LIMIT, DEFAULT_HELLO_LIMIT, DEFAULT_HOSTED_REQUEST_LIMIT, DEFAULT_HOSTED_SUBSCRIBER_LIMIT, type RateLimit } from "./rate_limit.ts";
import { DEFAULT_TRUSTED_PROXIES, parseCidr } from "./client_addr.ts";
import { DEFAULT_ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_USER_QUOTA, type AttachmentLimits } from "../shared/attachments.ts";
import { DEFAULT_RETENTION_DAYS, parseRetentionDays } from "../core/boards.ts";
import { DELEGATE_LIMIT, DELEGATE_OPEN_CAP } from "../core/delegation.ts";
import { ALIAS_SCOPE_CAP } from "./alias_cap.ts";
import { GOOGLE_ISSUER } from "./idp_google.ts";

export type McpLimits = Record<"listen" | "legacy" | "post", { global: number; perUser: number }>;
export const DEFAULT_MCP_LIMITS: McpLimits = { listen: { global: 128, perUser: 32 }, legacy: { global: 256, perUser: 32 }, post: { global: 256, perUser: 64 } };
// Hosted session rows, delivery leases and resource watches (#805, F-06); docs/guide/server.md §Sizing the caps.
// perService (#270 D4): the tier a service principal's sessions and leases count against in place of perUser, clamped
// under global like it; absent (a caller's own caps), a service gets perUser.
export type HostedCaps = { sessions: { global: number; perUser: number; perService?: number }; leases: { global: number; perUser: number; perService?: number }; watches: { global: number; perSession: number } };
export const DEFAULT_HOSTED_CAPS: HostedCaps = { sessions: { global: 4096, perUser: 256, perService: 1024 }, leases: { global: 256, perUser: 32, perService: 64 }, watches: { global: 1024, perSession: 32 } };
// A service principal's buckets (#270 D4), in place of the per-user ones: hosted tool calls and delivery upkeep, and
// binds. Keyed by the service's name as the user buckets are by email.
export type ServiceLimits = { hostedRequest: RateLimit; hostedSubscriber: RateLimit; bind: RateLimit };
export const DEFAULT_SERVICE_LIMITS: ServiceLimits = { hostedRequest: { burst: 480, perSec: 80 }, hostedSubscriber: { burst: 960, perSec: 160 }, bind: { burst: 240, perSec: 4 } };
// Every cap may be raised to this: a guard against a typo, not a tested size.
const CAP_CEILING = 1_000_000;

// The upstream identity providers a server can list (#928 D6), in GRAYBOARD_IDPS.
export const IDP_IDS = ["google", "okta"] as const;
export type IdpId = (typeof IDP_IDS)[number];
// The Okta org behind the generic OIDC provider (src/server/idp_oidc.ts): one per server.
export type OktaConfig = { issuer: string; clientId: string; clientSecret: string; allowedDomains: string[] };

// The server's database (#807 P3 C11b): a SQLite file, or a Postgres URL behind GRAYBOARD_UNRELEASED_POSTGRES=1 until
// the cutover (docs/future/postgres-server.md D8 P3, P5).
export type Store = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string };

export type Config = {
  store: Store;
  // Where attachment bytes are kept (src/server/blobs.ts); default blobs/ beside a SQLite database, required with a URL.
  blobDir: string;
  // GRAYBOARD_DATABASE_CONNECT_SECONDS (#1418): how long a Postgres store's first connection retries; absent, the
  // default (store/pg/connect.ts).
  databaseConnectSeconds?: number;
  httpPort: number;
  googleClientId: string;
  googleClientSecret: string;
  mcpGoogle?: { clientId: string; clientSecret: string };
  orgDomain: string;
  // GRAYBOARD_IDPS: the providers sign-in offers, in the chooser's order; absent means Google alone.
  idps?: IdpId[];
  okta?: OktaConfig;
  publicUrl: string;
  messageRetentionDays: number;
  auditRetentionDays: number;
  devAuth: boolean;
  // Days a CLI session token may go unused before it's refused (security audit F-14); 0 never.
  cliTokenIdleDays?: number;
  // Emails allowed to run admin commands. Empty means nobody can.
  admins: string[];
  oauthClients?: OAuthClient[];
  // Metadata-document (CIMD) client IDs the server resolves; default OpenCode's only (F-16).
  oauthCimdClients?: string[];
  // Who can reach another user's human; default "team".
  humanReach?: HumanReach;
  // Attachment size caps per file and per message; default local mode's.
  attachmentLimits?: AttachmentLimits;
  // The bytes of attachments one user may store, sent or not.
  attachmentUserQuota?: number;
  // Hellos per user: the burst, and the refill per second (#210).
  helloLimit: RateLimit;
  hostedRequestLimit?: RateLimit;
  hostedSubscriberLimit?: RateLimit;
  // /healthz fails on sustained event-loop lag (#805): p99Ms 0 is off.
  healthzLag?: LagGate;
  // delegate's limits (#252): GRAYBOARD_DELEGATE_BURST/_PER_SEC (per user) and
  // GRAYBOARD_DELEGATE_OPEN_CAP; defaults in src/core/delegation.ts.
  delegateLimit?: RateLimit;
  delegateOpenCap?: number;
  // Names per scope (#347): GRAYBOARD_ALIAS_SCOPE_CAP; default in src/server/alias_cap.ts.
  aliasScopeCap?: number;
  // Authentication failures per client address (#240), and the proxies
  // whose X-Forwarded-For is believed (CIDRs; default loopback).
  authFailLimit: RateLimit;
  oauthLimit?: RateLimit;
  oauthGlobalLimit?: RateLimit;
  mcpLimits?: McpLimits;
  hostedCaps?: HostedCaps;
  serviceLimits?: ServiceLimits;
  // A service credential's run tokens (#270 D2): GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS (the lifetime ceiling),
  // GRAYBOARD_SERVICE_TOKEN_MINTS_PER_MINUTE and GRAYBOARD_SERVICE_TOKENS_UNEXPIRED (per credential).
  serviceTokens?: ServiceTokenLimits;
  // How long an unbound, or bound but never-delivering, hosted session may idle (src/server/hosted.ts); default 900.
  hostedIdleSeconds?: number;
  // GRAYBOARD_METRICS_ADDR (#805): where the metrics listener binds; unset, there is none.
  metricsAddr?: { hostname: string; port: number };
  trustedProxies: readonly string[];
  // The org Slack bridge (src/server/slack.ts); off unless both tokens are set.
  slack?: { appToken: string; botToken: string; apiUrl?: string };
};

// The secrets a deploy may mount as files (#1418): NAME_FILE names a file whose contents become NAME, the
// Docker and Kubernetes convention, so a secret needn't sit in the process environment's source.
export const FILE_SECRETS = [
  "GRAYBOARD_DATABASE_URL", "GOOGLE_OAUTH_CLIENT_SECRET", "GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET",
  "GRAYBOARD_OKTA_CLIENT_SECRET", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN",
] as const;

// Resolves each NAME_FILE into env.NAME before anything reads it. Both set (to different values) is refused: which
// one wins would be a guess. Trailing line breaks are dropped (an editor or `echo` adds one); an empty or unreadable file is refused,
// naming the variable and path, never the contents.
export function resolveFileSecrets(env: Record<string, string | undefined>): void {
  for (const name of FILE_SECRETS) {
    const path = env[`${name}_FILE`];
    if (!path) continue;
    let value: string;
    try {
      value = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`${name}_FILE: cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    value = value.replace(/[\r\n]+$/, "");
    if (!value) throw new Error(`${name}_FILE: ${path} is empty`);
    // NAME equal to the file is this resolution run before (a second loadConfig), not a second source.
    if (env[name] && env[name] !== value) throw new Error(`Set one of ${name}, ${name}_FILE, not both`);
    env[name] = value;
  }
}

export function loadConfig(): Config {
  resolveFileSecrets(process.env);
  const devAuth = process.env.GRAYBOARD_DEV_AUTH === "1";

  if (devAuth && (process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET || process.env.GRAYBOARD_OKTA_CLIENT_SECRET)) {
    throw new Error(
      "GRAYBOARD_DEV_AUTH=1 must not be set alongside GOOGLE_OAUTH_CLIENT_SECRET, GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET or GRAYBOARD_OKTA_CLIENT_SECRET (prevents prod misconfig)",
    );
  }

  const { store, blobDir } = storeConfig(process.env);
  const publicUrl = requireEnv("GRAYBOARD_PUBLIC_URL");

  // Dev sign-in lets anyone who reaches the server act as anyone (#805 F-04): a
  // public URL means others can reach it, so it's for local development only.
  if (devAuth && !isLoopback(urlHostname(publicUrl))) {
    throw new Error(`GRAYBOARD_DEV_AUTH=1 needs a loopback GRAYBOARD_PUBLIC_URL (localhost, 127.0.0.1 or [::1]), not ${publicUrl}: dev sign-in lets anyone who reaches the server act as anyone`);
  }

  const idps = parseIdps(process.env.GRAYBOARD_IDPS);
  const google = idps.includes("google");
  const okta = oktaConfig(idps.includes("okta"));

  // One Google client pair (#928 D6, D8): the MCP pair when set, else the primary, which is then required. A
  // deployment with a Desktop primary pair and a Web MCP pair runs on the Web pair; its Desktop pair goes unused.
  // Google's variables and GRAYBOARD_ORG_DOMAIN are read only when google is listed.
  const mcpGoogle          = google ? mcpGoogleConfig() : {};
  const primaryRequired    = google && !devAuth && !mcpGoogle.mcpGoogle;
  const googleClientId     = primaryRequired ? requireEnv("GOOGLE_OAUTH_CLIENT_ID") : !google ? "" : (process.env.GOOGLE_OAUTH_CLIENT_ID ?? (devAuth ? "dev" : ""));
  const googleClientSecret = primaryRequired ? requireEnv("GOOGLE_OAUTH_CLIENT_SECRET") : devAuth || !google ? "" : (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "");
  const orgDomain          = !google ? "" : devAuth ? (process.env.GRAYBOARD_ORG_DOMAIN ?? "example.com") : requireEnv("GRAYBOARD_ORG_DOMAIN");
  const identity = { idps, ...(okta ? { okta } : {}), devAuth, googleClientSecret, ...mcpGoogle };
  checkIdpConfig(identity);

  return {
    store,
    blobDir,
    ...connectSeconds(process.env.GRAYBOARD_DATABASE_CONNECT_SECONDS),
    httpPort: parsePort(process.env.GRAYBOARD_HTTP_PORT),
    googleClientId,
    googleClientSecret,
    ...mcpGoogle,
    orgDomain,
    idps,
    ...(okta ? { okta } : {}),
    publicUrl: publicUrl.replace(/\/$/, ""),
    messageRetentionDays: retentionDays("GRAYBOARD_MESSAGE_RETENTION_DAYS", process.env.GRAYBOARD_MESSAGE_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    auditRetentionDays:   retentionDays("GRAYBOARD_AUDIT_RETENTION_DAYS",   process.env.GRAYBOARD_AUDIT_RETENTION_DAYS,   90),
    devAuth,
    cliTokenIdleDays: idleDays(process.env.GRAYBOARD_CLI_TOKEN_IDLE_DAYS),
    admins: parseList(process.env.GRAYBOARD_ADMINS),
    oauthClients: parseOAuthClients(process.env.GRAYBOARD_OAUTH_CLIENTS),
    oauthCimdClients: parseCimdClients(process.env.GRAYBOARD_OAUTH_CIMD_CLIENTS),
    humanReach: parseReach(process.env.GRAYBOARD_SLACK_REACH),
    ...parseAttachmentLimits(process.env),
    helloLimit: parseRateLimit(process.env, "GRAYBOARD_HELLO", DEFAULT_HELLO_LIMIT, "hellos"),
    hostedRequestLimit: parseRateLimit(process.env, "GRAYBOARD_HOSTED_REQUEST", DEFAULT_HOSTED_REQUEST_LIMIT, "requests"),
    hostedSubscriberLimit: parseRateLimit(process.env, "GRAYBOARD_HOSTED_SUBSCRIBER", DEFAULT_HOSTED_SUBSCRIBER_LIMIT, "requests"),
    authFailLimit: parseRateLimit(process.env, "GRAYBOARD_AUTH_FAIL", DEFAULT_AUTH_FAIL_LIMIT, "failures"),
    oauthLimit: parseRateLimit(process.env, "GRAYBOARD_OAUTH", { burst: 60, perSec: 1 }, "requests"),
    oauthGlobalLimit: parseRateLimit(process.env, "GRAYBOARD_OAUTH_GLOBAL", { burst: 600, perSec: 10 }, "requests"),
    delegateLimit: parseRateLimit(process.env, "GRAYBOARD_DELEGATE", DELEGATE_LIMIT, "requests"),
    delegateOpenCap: positiveInt(process.env, "GRAYBOARD_DELEGATE_OPEN_CAP", DELEGATE_OPEN_CAP, MAX_BURST, "requests"),
    aliasScopeCap: positiveInt(process.env, "GRAYBOARD_ALIAS_SCOPE_CAP", ALIAS_SCOPE_CAP, CAP_CEILING, "names"),
    mcpLimits: parseMcpLimits(process.env),
    hostedCaps: parseHostedCaps(process.env),
    serviceLimits: {
      hostedRequest: parseRateLimit(process.env, "GRAYBOARD_HOSTED_REQUEST_SERVICE", DEFAULT_SERVICE_LIMITS.hostedRequest, "requests"),
      hostedSubscriber: parseRateLimit(process.env, "GRAYBOARD_HOSTED_SUBSCRIBER_SERVICE", DEFAULT_SERVICE_LIMITS.hostedSubscriber, "requests"),
      bind: parseRateLimit(process.env, "GRAYBOARD_HELLO_SERVICE", DEFAULT_SERVICE_LIMITS.bind, "hellos"),
    },
    serviceTokens: {
      maxSeconds: serviceTokenCeiling(process.env),
      mintsPerMinute: positiveInt(process.env, "GRAYBOARD_SERVICE_TOKEN_MINTS_PER_MINUTE", DEFAULT_SERVICE_TOKEN_LIMITS.mintsPerMinute, CAP_CEILING, "tokens"),
      unexpired: positiveInt(process.env, "GRAYBOARD_SERVICE_TOKENS_UNEXPIRED", DEFAULT_SERVICE_TOKEN_LIMITS.unexpired, CAP_CEILING, "tokens"),
    },
    ...(process.env.GRAYBOARD_HOSTED_IDLE_SECONDS ? { hostedIdleSeconds: positiveInt(process.env, "GRAYBOARD_HOSTED_IDLE_SECONDS", 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000), "seconds") } : {}),
    trustedProxies: parseTrustedProxies(process.env.GRAYBOARD_TRUSTED_PROXIES),
    healthzLag: {
      p99Ms: process.env.GRAYBOARD_HEALTHZ_LAG_P99_MS === "0" ? 0 : positiveInt(process.env, "GRAYBOARD_HEALTHZ_LAG_P99_MS", DEFAULT_LAG_GATE.p99Ms, 600_000, "milliseconds"),
      windows: positiveInt(process.env, "GRAYBOARD_HEALTHZ_LAG_WINDOWS", DEFAULT_LAG_GATE.windows, LAG_HISTORY, "windows"),
    },
    ...(process.env.GRAYBOARD_METRICS_ADDR ? { metricsAddr: parseMetricsAddr(process.env.GRAYBOARD_METRICS_ADDR) } : {}),
    ...slackConfig(),
  };
}

function parseMcpLimits(env: Record<string, string | undefined>): McpLimits {
  const limits = {} as McpLimits;
  for (const kind of ["listen", "legacy", "post"] as const) {
    const prefix = `GRAYBOARD_MCP_${kind.toUpperCase()}`;
    const defaults = DEFAULT_MCP_LIMITS[kind];
    const { global, scoped } = globalAndScoped(env, prefix, "PER_USER", defaults.global, defaults.perUser, "requests");
    limits[kind] = { global, perUser: scoped };
  }
  return limits;
}

// At least the mint bucket's window (SERVICE_TOKEN_MIN_SECONDS), at most a year.
function serviceTokenCeiling(env: Record<string, string | undefined>): number {
  const n = positiveInt(env, "GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS", DEFAULT_SERVICE_TOKEN_LIMITS.maxSeconds, 366 * 24 * 60 * 60, "seconds");
  if (n < SERVICE_TOKEN_MIN_SECONDS) throw new Error(`GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS must be at least ${SERVICE_TOKEN_MIN_SECONDS} seconds`);
  return n;
}

function parseHostedCaps(env: Record<string, string | undefined>): HostedCaps {
  const d = DEFAULT_HOSTED_CAPS;
  const sessions = globalAndScoped(env, "GRAYBOARD_HOSTED_SESSIONS", "PER_USER", d.sessions.global, d.sessions.perUser, "sessions");
  const leases = globalAndScoped(env, "GRAYBOARD_DELIVERY_LEASES", "PER_USER", d.leases.global, d.leases.perUser, "leases");
  const watches = globalAndScoped(env, "GRAYBOARD_RESOURCE_WATCHES", "PER_SESSION", d.watches.global, d.watches.perSession, "watches");
  // The service tier (#270 D4), clamped under the same global as the per-user value.
  const sessionsPerService = globalAndScoped(env, "GRAYBOARD_HOSTED_SESSIONS", "PER_SERVICE", d.sessions.global, d.sessions.perService!, "sessions").scoped;
  const leasesPerService = globalAndScoped(env, "GRAYBOARD_DELIVERY_LEASES", "PER_SERVICE", d.leases.global, d.leases.perService!, "leases").scoped;
  return { sessions: { global: sessions.global, perUser: sessions.scoped, perService: sessionsPerService }, leases: { global: leases.global, perUser: leases.scoped, perService: leasesPerService },
    watches: { global: watches.global, perSession: watches.scoped } };
}

// A server-wide cap and a narrower one (per user or per session), which can't exceed it. An unset narrower cap
// keeps its default, lowered to the server-wide one when that is set below it.
function globalAndScoped(env: Record<string, string | undefined>, prefix: string, scope: string, global0: number, scoped0: number, unit: string) {
  const global = positiveInt(env, `${prefix}_GLOBAL`, global0, CAP_CEILING, unit);
  const scoped = positiveInt(env, `${prefix}_${scope}`, Math.min(scoped0, global), global, unit);
  return { global, scoped };
}

// GRAYBOARD_IDPS: provider IDs, comma-separated, in the chooser's order; unset is Google alone, so an existing
// deployment's env is unchanged.
function parseIdps(raw: string | undefined): IdpId[] {
  if (raw === undefined) return ["google"];
  const idps = raw.split(",").map(s => s.trim()) as IdpId[];
  checkIdpList(idps);
  return idps;
}

function checkIdpList(idps: readonly string[]): void {
  if (!idps.length || idps.some(id => id === "")) throw new Error("GRAYBOARD_IDPS has an empty entry: list provider IDs, comma-separated (google, okta)");
  for (const id of idps) if (!(IDP_IDS as readonly string[]).includes(id)) throw new Error(`GRAYBOARD_IDPS: unknown provider "${id}" (known: ${IDP_IDS.join(", ")})`);
  if (new Set(idps).size !== idps.length) throw new Error("GRAYBOARD_IDPS lists a provider twice");
}

const OKTA_VARS = ["GRAYBOARD_OKTA_ISSUER", "GRAYBOARD_OKTA_CLIENT_ID", "GRAYBOARD_OKTA_CLIENT_SECRET", "GRAYBOARD_OKTA_ALLOWED_DOMAINS"] as const;

// Okta's four variables, all required when okta is listed. One set while it isn't is a typo, as half an MCP Google
// pair is: a half-configured provider never silently goes unused.
function oktaConfig(listed: boolean): OktaConfig | undefined {
  const set = OKTA_VARS.filter(name => process.env[name]);
  if (!listed) {
    if (set.length) throw new Error(`${set.join(", ")} set but GRAYBOARD_IDPS doesn't list okta: list it, or unset them`);
    return undefined;
  }
  for (const name of OKTA_VARS) if (!process.env[name]) throw new Error(`GRAYBOARD_IDPS lists okta, so ${name} is required`);
  return {
    issuer: process.env.GRAYBOARD_OKTA_ISSUER!,
    clientId: process.env.GRAYBOARD_OKTA_CLIENT_ID!,
    clientSecret: process.env.GRAYBOARD_OKTA_CLIENT_SECRET!,
    allowedDomains: process.env.GRAYBOARD_OKTA_ALLOWED_DOMAINS!.split(",").map(d => d.trim().toLowerCase()),
  };
}

const CREDENTIAL = /^[\x21-\x7e]{1,4096}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// The identity-provider rules (#928 D6), on Config alone: loadConfig and createOAuthServer both run it, and neither
// reads an injected provider list (tests inject a provider holding a secret under dev auth). Errors never quote a
// credential.
export function checkIdpConfig(config: Pick<Config, "idps" | "okta" | "devAuth" | "googleClientSecret" | "mcpGoogle">): void {
  const idps = config.idps ?? ["google"];
  checkIdpList(idps);
  const okta = config.okta;
  if (!idps.includes("okta") && okta) throw new Error("Okta is configured but GRAYBOARD_IDPS doesn't list okta");
  if (idps.includes("okta")) {
    if (!okta) throw new Error("GRAYBOARD_IDPS lists okta without its configuration");
    let url: URL | undefined;
    try { url = new URL(okta.issuer); } catch { /* refused below */ }
    if (!url || url.protocol !== "https:" || /[?#]/.test(okta.issuer) || okta.issuer.endsWith("/") || url.username || url.password)
      throw new Error("GRAYBOARD_OKTA_ISSUER must be an https URL with no query, fragment or trailing slash (the issuer exactly as the org's discovery document gives it)");
    if (okta.issuer === GOOGLE_ISSUER) throw new Error("GRAYBOARD_OKTA_ISSUER can't be Google's issuer");
    if (!CREDENTIAL.test(okta.clientId) || !CREDENTIAL.test(okta.clientSecret))
      throw new Error("GRAYBOARD_OKTA_CLIENT_ID and GRAYBOARD_OKTA_CLIENT_SECRET must be nonempty credentials without whitespace");
    if (!okta.allowedDomains.length || okta.allowedDomains.some(d => !DOMAIN.test(d)))
      throw new Error(`GRAYBOARD_OKTA_ALLOWED_DOMAINS must be email domains, comma-separated (example.com), not "${okta.allowedDomains.join(",")}"`);
  }
  if (config.devAuth && (config.googleClientSecret || config.mcpGoogle?.clientSecret || okta?.clientSecret))
    throw new Error("dev auth must not coexist with an identity provider's client secret");
}

function mcpGoogleConfig(): Pick<Config, "mcpGoogle"> {
  const clientId = process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET;
  if (clientId === undefined && clientSecret === undefined) return {};
  if (!clientId || !clientSecret || !/^[\x21-\x7e]{1,4096}$/.test(clientId) || !/^[\x21-\x7e]{1,4096}$/.test(clientSecret)) {
    throw new Error("set both GRAYBOARD_MCP_GOOGLE_CLIENT_ID and GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET to nonempty credentials without whitespace, or neither");
  }
  return { mcpGoogle: { clientId, clientSecret } };
}

// The most an operator may raise the caps to. An upload's body is held in
// memory while it's checked (src/server/uploads.ts bounds how many at once).
const MAX_FILE_CEILING = 100 * 1024 * 1024;
const MAX_TOTAL_CEILING = 250 * 1024 * 1024;

function parseAttachmentLimits(env: Record<string, string | undefined>): { attachmentLimits: AttachmentLimits; attachmentUserQuota: number } {
  const bytes = (name: string, fallback: number, ceiling = Infinity) => positiveInt(env, name, fallback, ceiling, "bytes");
  const file = bytes("GRAYBOARD_ATTACHMENT_MAX_BYTES", DEFAULT_ATTACHMENT_LIMITS.file, MAX_FILE_CEILING);
  const total = bytes("GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES", DEFAULT_ATTACHMENT_LIMITS.total, MAX_TOTAL_CEILING);
  if (file > total) throw new Error("GRAYBOARD_ATTACHMENT_MAX_BYTES can't exceed GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES");
  const quota = bytes("GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES", DEFAULT_ATTACHMENT_USER_QUOTA);
  if (quota < total) throw new Error("GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES can't be less than GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES");
  return { attachmentLimits: { file, total }, attachmentUserQuota: quota };
}

// The rate's floor caps one token's refill at 10s, so a limited caller is
// never told to wait longer than that. The burst's ceiling keeps a typo from
// switching the limit off.
const MIN_PER_SEC = 0.1;
const MAX_BURST = 10_000;

// `${prefix}_BURST` and `${prefix}_PER_SEC`.
function parseRateLimit(env: Record<string, string | undefined>, prefix: string, fallback: RateLimit, unit: string): RateLimit {
  const name = `${prefix}_PER_SEC`;
  const perSec = env[name];
  if (perSec !== undefined && perSec !== "" && !(/^[0-9]*\.?[0-9]+$/.test(perSec) && Number(perSec) >= MIN_PER_SEC)) {
    throw new Error(`${name} must be a number of at least ${MIN_PER_SEC}, not "${perSec}"`);
  }
  return {
    burst: positiveInt(env, `${prefix}_BURST`, fallback.burst, MAX_BURST, unit),
    perSec: perSec ? Number(perSec) : fallback.perSec,
  };
}

// Unset or empty: loopback. "none": nobody. Otherwise IPs or CIDRs, comma-separated.
function parseTrustedProxies(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TRUSTED_PROXIES];
  if (raw.trim() === "none") return [];
  return raw.split(",").map((c) => {
    try {
      return parseCidr(c);
    } catch (e) {
      throw new Error(`GRAYBOARD_TRUSTED_PROXIES: ${(e as Error).message}; give IPs or CIDRs, comma-separated, or "none"`);
    }
  });
}

// A positive whole-number setting: unset or empty takes the fallback.
// Plain digits only, so "1e3" and " 8" don't slip through Number().
function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number, ceiling: number, unit: string): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive whole number of ${unit}, not "${raw}"`);
  if (Number(raw) > ceiling) throw new Error(`${name} can be at most ${ceiling} ${unit}`);
  return Number(raw);
}

function parseReach(raw: string | undefined): HumanReach {
  if (raw === undefined || raw === "" || raw === "team") return "team";
  if (raw === "all") return "all";
  throw new Error(`GRAYBOARD_SLACK_REACH must be "team" or "all", not "${raw}"`);
}

// Half a configuration is a mistake, not "off".
function slackConfig(): { slack?: Config["slack"] } {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken && !botToken) return {};
  if (!appToken || !botToken) throw new Error("set both SLACK_APP_TOKEN and SLACK_BOT_TOKEN to run the Slack bridge, or neither");
  if (!appToken.startsWith("xapp-")) throw new Error("SLACK_APP_TOKEN should be an app-level token (xapp-…)");
  if (!botToken.startsWith("xoxb-")) throw new Error("SLACK_BOT_TOKEN should be a bot token (xoxb-…)");
  return { slack: { appToken, botToken, ...(process.env.SLACK_API_URL ? { apiUrl: process.env.SLACK_API_URL } : {}) } };
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function urlHostname(raw: string): string {
  try { return new URL(raw).hostname; } catch { return ""; }
}

// One of GRAYBOARD_DATABASE_URL and GRAYBOARD_DB_PATH: both set would hide a misconfigured deploy behind a silent
// precedence. The URL needs the unreleased gate (PS D8: the two stores never coexist in a release, so a release cut
// before P5 must not honour it) and an explicit blob directory (no database directory to put it beside).
function storeConfig(env: Record<string, string | undefined>): { store: Store; blobDir: string } {
  const url = env.GRAYBOARD_DATABASE_URL, path = env.GRAYBOARD_DB_PATH, blobDir = env.GRAYBOARD_BLOB_DIR;
  if (url && path) throw new Error("Set one of GRAYBOARD_DATABASE_URL, GRAYBOARD_DB_PATH, not both");
  if (path) return { store: { kind: "sqlite", path }, blobDir: blobDir || join(dirname(path), "blobs") };
  if (!url) throw new Error("Required env var GRAYBOARD_DB_PATH (or GRAYBOARD_DATABASE_URL) is not set");
  if (env.GRAYBOARD_UNRELEASED_POSTGRES !== "1") throw new Error("GRAYBOARD_DATABASE_URL needs GRAYBOARD_UNRELEASED_POSTGRES=1: the Postgres store is unreleased");
  if (!blobDir) throw new Error("GRAYBOARD_DATABASE_URL needs GRAYBOARD_BLOB_DIR: there's no database directory to keep attachments beside");
  return { store: { kind: "postgres", url }, blobDir };
}

// What the startup line names: the backend and where, never a URL's credentials.
export function describeStore(store: Store): string {
  if (store.kind === "sqlite") return `sqlite ${store.path}`;
  try {
    const u = new URL(store.url);
    return `postgres ${u.host}${u.pathname}`;
  } catch {
    return "postgres (unparsable URL)";
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

// Retention days parse through the shared rule (src/core/boards.ts's parseRetentionDays,
// the same one local mode's BUS_RETENTION_DAYS uses): a positive whole number of days, or
// unset for the default — refusing to start otherwise. NaN here would make every
// `created_at < cutoff` false and silently prune nothing.
function retentionDays(name: string, raw: string | undefined, fallback: number): number {
  const days = parseRetentionDays(raw, fallback);
  if (days === null) throw new Error(`${name} must be a whole number of days, not "${raw}"`);
  return days;
}

// GRAYBOARD_METRICS_ADDR: `host:port`, `[v6]:port`, or a bare port (binds 127.0.0.1). Unset: no listener.
export function parseMetricsAddr(raw: string | undefined): { hostname: string; port: number } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const m = /^(?:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):)?(\d+)$/.exec(raw);
  const port = m ? Number(m[2]) : NaN;
  if (!m || port > 65535) throw new Error(`GRAYBOARD_METRICS_ADDR must be host:port or a port, not "${raw}"`);
  const host = m[1] ?? "127.0.0.1";
  return { hostname: host.startsWith("[") ? host.slice(1, -1) : host, port };
}

// CLI token idle days: unset or empty is the default, 0 is never, else a
// whole number of days up to ten years. Plain digits, as elsewhere here.
export const DEFAULT_CLI_TOKEN_IDLE_DAYS = 30;
function connectSeconds(raw: string | undefined): { databaseConnectSeconds?: number } {
  if (raw === undefined || raw === "") return {};
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) > 3600) {
    throw new Error(`GRAYBOARD_DATABASE_CONNECT_SECONDS must be a whole number of seconds from 0 (one try) to 3600, not "${raw}"`);
  }
  return { databaseConnectSeconds: Number(raw) };
}

function idleDays(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CLI_TOKEN_IDLE_DAYS;
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) > 3650) {
    throw new Error(`GRAYBOARD_CLI_TOKEN_IDLE_DAYS must be a whole number of days from 0 (never expire) to 3650, not "${raw}"`);
  }
  return Number(raw);
}

// Port 0 (an ephemeral port, what tests use) through 65535. Gated to plain digits so
// "1e3", "0x1F90" and " 8080 " don't slip through Number().
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 8080;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`GRAYBOARD_HTTP_PORT must be a port between 0 and 65535, not "${raw}"`);
  }
  return Number(raw);
}
