// A scripted browser for a grayboard server's OAuth pages (#490): a cookie
// jar over fetch that never follows a redirect (each test checks the 303 and
// its Location), plus the consent page's hidden fields and their submit.
// `tests/e2e/opencode-config.ts` keeps its own copy: hosted-e2e.sh copies
// that driver alone into a prepared tree.

export type BrowserOptions = {
  // Where a URL the server named is actually fetched (a public URL mapped to
  // the listener's address).
  rewrite?: (url: string) => string;
  // Cookies the browser starts with (a session written by hand).
  cookies?: Record<string, string>;
  // Each raw Set-Cookie header, for a test that checks its attributes.
  onSetCookie?: (raw: string) => void;
};

export class Browser {
  jar: Map<string, string>;
  constructor(private o: BrowserOptions = {}) { this.jar = new Map(Object.entries(o.cookies ?? {})); }
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", this.cookie);
    const response = await fetch(this.o.rewrite?.(url) ?? url, { ...init, headers, redirect: "manual" });
    for (const raw of response.headers.getSetCookie()) {
      this.o.onSetCookie?.(raw);
      // A value may itself hold "=": split at the first one only.
      const pair = raw.split(";")[0]!, i = pair.indexOf("=");
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return response;
  }
}

// The consent page's hidden `request` and `csrf` fields; empty when the page
// has none, so the submit fails at the server rather than here.
export function consentForm(page: string): { request: string; csrf: string } {
  return { request: /name="request" value="([^"]+)"/.exec(page)?.[1] ?? "", csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "" };
}

// Posts the consent decision from `origin` (the page's own, by default).
export function submitConsent(browser: Browser, action: string, form: { request: string; csrf: string }, decision = "approve", origin = new URL(action).origin): Promise<Response> {
  return browser.request(action, { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ request: form.request, csrf: form.csrf, decision }) });
}
