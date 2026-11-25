// AWS credentials for the S3 attachment store (#1509). Bun's S3Client signs with keys it is handed (or reads from
// AWS_* env vars) and has no web-identity provider, so this module supplies them: on EKS with IRSA, the pod's
// projected service-account token exchanged for a role's temporary keys through STS AssumeRoleWithWebIdentity (an
// unsigned call); otherwise static keys from the environment.
//
// Lazy, with no timers: get() returns the cached keys while they are more than REFRESH_MARGIN_MS from expiry, else
// refreshes, one exchange shared by every concurrent caller. A refresh that fails while the cached keys are still
// valid serves them, logs once per failure streak and waits RETRY_MS before trying again; one that fails after they
// expire throws. A background refresher would be one more pass for the server's stop() to drain.
//
// Secrets never leave this module in text: an error names the role ARN, the STS endpoint, and STS's own error code and
// message, never the web identity token, the request body or a key.
import { readFile } from "node:fs/promises";

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  // Epoch ms; absent for static keys, which don't expire.
  expiration?: number;
};

// Where the keys come from, resolved from the environment at config time (config.ts s3BlobConfig).
export type AwsCredentialSpec =
  | { kind: "web-identity"; roleArn: string; tokenFile: string; stsEndpoint: string; sessionName: string }
  | { kind: "static"; accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export interface CredentialSource {
  get(): Promise<AwsCredentials>;
}

export const REFRESH_MARGIN_MS = 5 * 60_000;
export const RETRY_MS = 30_000;
export const STS_TIMEOUT_MS = 10_000;
// A role's default maximum session; STS refuses more than the role allows.
export const SESSION_SECONDS = 3600;

export type CredentialOptions = {
  now?: () => number;
  log?: (line: string) => void;
  stsTimeoutMs?: number;
};

export function credentialSource(spec: AwsCredentialSpec, opts: CredentialOptions = {}): CredentialSource {
  if (spec.kind === "static") {
    const creds: AwsCredentials = { accessKeyId: spec.accessKeyId, secretAccessKey: spec.secretAccessKey, ...(spec.sessionToken ? { sessionToken: spec.sessionToken } : {}) };
    return { get: async () => creds };
  }
  return new WebIdentityCredentials(spec, opts);
}

// What the startup line says about the credentials: the source and role, never a key.
export function describeCredentials(spec: AwsCredentialSpec): string {
  return spec.kind === "web-identity" ? `web identity, role ${spec.roleArn}` : "static keys";
}

class WebIdentityCredentials implements CredentialSource {
  private cached: AwsCredentials | undefined;
  private inflight: Promise<AwsCredentials> | undefined;
  private retryAt = 0;
  private warned = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(private readonly spec: Extract<AwsCredentialSpec, { kind: "web-identity" }>, opts: CredentialOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
    this.timeoutMs = opts.stsTimeoutMs ?? STS_TIMEOUT_MS;
  }

  async get(): Promise<AwsCredentials> {
    const cached = this.cached;
    const now = this.now();
    if (cached && cached.expiration! - now > REFRESH_MARGIN_MS) return cached;
    // A recent refresh failed: keep serving the valid keys rather than calling STS on every operation.
    if (cached && cached.expiration! > now && now < this.retryAt) return cached;
    this.inflight ??= assumeRoleWithWebIdentity(this.spec, this.timeoutMs).finally(() => { this.inflight = undefined; });
    try {
      const fresh = await this.inflight;
      this.cached = fresh;
      this.warned = false;
      this.retryAt = 0;
      return fresh;
    } catch (e) {
      const still = this.cached;
      if (still && still.expiration! > this.now()) {
        this.retryAt = this.now() + RETRY_MS;
        if (!this.warned) {
          this.warned = true;
          this.log(`[grayboard] S3 credentials: refresh failed, using keys valid until ${new Date(still.expiration!).toISOString()}: ${(e as Error).message}`);
        }
        return still;
      }
      throw e;
    }
  }
}

const cut = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
const xmlField = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// One AssumeRoleWithWebIdentity exchange. The token file is re-read every time: the kubelet rotates it. The token goes
// in a POST body, never the URL: URLs reach fetch errors and proxy logs.
export async function assumeRoleWithWebIdentity(spec: Extract<AwsCredentialSpec, { kind: "web-identity" }>, timeoutMs = STS_TIMEOUT_MS): Promise<AwsCredentials> {
  const what = `STS AssumeRoleWithWebIdentity for ${spec.roleArn}`;
  let token: string;
  try {
    token = (await readFile(spec.tokenFile, "utf8")).trim();
  } catch (e) {
    throw new Error(`${what}: cannot read AWS_WEB_IDENTITY_TOKEN_FILE ${spec.tokenFile}: ${(e as NodeJS.ErrnoException).code ?? "read failed"}`);
  }
  if (!token) throw new Error(`${what}: AWS_WEB_IDENTITY_TOKEN_FILE ${spec.tokenFile} is empty`);
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: spec.roleArn,
    RoleSessionName: spec.sessionName,
    WebIdentityToken: token,
    DurationSeconds: String(SESSION_SECONDS),
  });
  let res: Response;
  let text: string;
  try {
    res = await fetch(spec.stsEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/xml" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    // A fetch error names the URL, which carries nothing secret; never the body.
    const err = e as Error;
    throw new Error(`${what} at ${spec.stsEndpoint}: ${err.name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : cut(err.message)}`);
  }
  if (!res.ok) {
    const code = xmlField(text, "Code");
    const message = xmlField(text, "Message");
    throw new Error(`${what}: HTTP ${res.status}${code ? ` ${cut(unescapeXml(code), 80)}` : ""}${message ? `: ${cut(unescapeXml(message))}` : ""}`);
  }
  // The answer carries the secret key: parse it narrowly, and never quote it.
  const result = /<AssumeRoleWithWebIdentityResult>([\s\S]*?)<\/AssumeRoleWithWebIdentityResult>/.exec(text)?.[1];
  const creds = result && /<Credentials>([\s\S]*?)<\/Credentials>/.exec(result)?.[1];
  const accessKeyId = creds && xmlField(creds, "AccessKeyId");
  const secretAccessKey = creds && xmlField(creds, "SecretAccessKey");
  const sessionToken = creds && xmlField(creds, "SessionToken");
  const expiration = creds ? Date.parse(xmlField(creds, "Expiration") ?? "") : NaN;
  if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expiration)) {
    throw new Error(`${what}: HTTP ${res.status} without the credentials it should carry`);
  }
  return { accessKeyId: unescapeXml(accessKeyId), secretAccessKey: unescapeXml(secretAccessKey), sessionToken: unescapeXml(sessionToken), expiration };
}
