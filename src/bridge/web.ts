// Slack Web API over fetch: the few methods the bridge calls. Slack answers
// HTTP 200 with {ok:false, error} for most failures, and 429 + Retry-After
// (error "ratelimited") when throttled.

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

  async call<T = Record<string, unknown>>(method: string, body: Record<string, unknown> = {}): Promise<T & { ok: true }> {
    for (let waits = 0; ; waits++) {
      let res: Response;
      try {
        res = await this.fetchImpl(new URL(method, this.base).toString(), {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new SlackUnavailable(`slack ${method}: ${(e as Error).message}`);
      }
      if (res.status >= 500) throw new SlackUnavailable(`slack ${method}: HTTP ${res.status}`);
      let data: { ok?: boolean; error?: string } = {};
      try {
        data = (await res.json()) as typeof data;
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
}
