// Slack Web API over fetch: the few methods the bridge calls, plus file bytes
// both ways. Slack answers HTTP 200 with {ok:false, error} for most failures,
// and 429 + Retry-After (error "ratelimited") when throttled.

import { HTTP_TIMEOUT_MS, describeFetchError, transferTimeoutMs } from "../shared/http.ts";

export const SLACK_API = "https://slack.com/api/";

// Failures a retry can't fix: the token or the channel is wrong. The bridge
// exits on these rather than retrying forever.
const FATAL = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
]);

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method}: ${code}`);
  }
  get fatal(): boolean {
    return FATAL.has(this.code);
  }
}

/** A failure worth retrying: the network, a 5xx, or a rate limit that outlasted our waits. */
export class SlackUnavailable extends Error {}

const MAX_RATELIMIT_WAITS = 5;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class SlackWeb {
  constructor(
    private readonly token: string,
    private readonly base = SLACK_API,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  // form: send the arguments form-encoded (non-string values as JSON), the
  // encoding every method takes; the files.* methods get it.
  async call<T = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown> = {},
    opts: { form?: boolean } = {},
  ): Promise<T & { ok: true }> {
    const encoded = opts.form
      ? {
          type: "application/x-www-form-urlencoded",
          body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString(),
        }
      : { type: "application/json; charset=utf-8", body: JSON.stringify(body) };
    for (let waits = 0; ; waits++) {
      let res: Response;
      try {
        res = await this.fetchImpl(new URL(method, this.base).toString(), {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": encoded.type },
          body: encoded.body,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (e) {
        throw new SlackUnavailable(`slack ${method}: ${describeFetchError(e, HTTP_TIMEOUT_MS)}`);
      }
      if (res.status >= 500) throw new SlackUnavailable(`slack ${method}: HTTP ${res.status}`);
      let data: { ok?: boolean; error?: string } = {};
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        throw new SlackUnavailable(`slack ${method}: ${describeFetchError(e, HTTP_TIMEOUT_MS)}`);
      }
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        if (res.status !== 429) throw new SlackUnavailable(`slack ${method}: HTTP ${res.status}, not JSON`);
      }
      if (res.status === 429 || data.error === "ratelimited") {
        if (waits >= MAX_RATELIMIT_WAITS) throw new SlackUnavailable(`slack ${method}: still rate limited`);
        const s = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
        await Bun.sleep((Number.isFinite(s) && s > 0 ? s : 1) * 1000);
        continue;
      }
      if (!data.ok) throw new SlackError(method, data.error ?? `HTTP ${res.status}`);
      return data as T & { ok: true };
    }
  }

  /** Sends a file's bytes to the upload_url files.getUploadURLExternal gave. */
  async upload(url: string, data: Uint8Array): Promise<void> {
    const ms = transferTimeoutMs(data.length);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      throw new SlackUnavailable(`slack file upload: ${describeFetchError(e, ms)}`);
    }
    if (res.status >= 500 || res.status === 429) throw new SlackUnavailable(`slack file upload: HTTP ${res.status}`);
    if (res.status !== 200) throw new SlackError("file upload", `HTTP ${res.status}`);
  }

  /**
   * A shared file's bytes, from its url_private_download. Without files:read,
   * Slack answers with a sign-in page instead, so a size other than `size`
   * (the file's, from Slack) is refused.
   */
  async download(url: string, size: number): Promise<Uint8Array> {
    const ms = transferTimeoutMs(size);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw new SlackUnavailable(`slack file download: ${describeFetchError(e, ms)}`);
    }
    if (res.status >= 500 || res.status === 429) throw new SlackUnavailable(`slack file download: HTTP ${res.status}`);
    if (res.status !== 200) throw new SlackError("file download", `HTTP ${res.status}`);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new SlackUnavailable(`slack file download: ${describeFetchError(e, ms)}`);
    }
    if (data.length !== size) throw new SlackError("file download", "size_mismatch");
    return data;
  }
}
