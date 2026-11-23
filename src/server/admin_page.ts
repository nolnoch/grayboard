// The admin dashboard's page (#1651 D3, D4), served without a token: it holds no data, and signs in through the
// grayboard-admin OAuth client, whose one redirect is /admin/callback here. Every response under /admin carries
// ADMIN_HEADERS: same-origin scripts, styles and fetches only, so neither an inline script nor eval runs, no other
// site frames it, and no Referer carries the callback's code off the page.

export const ADMIN_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ADMIN_HEADERS = {
  "Content-Security-Policy": ADMIN_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};
// The page's markup; step 3 of #1651 replaces this stub with the dashboard and its same-origin assets.
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>Grayboard admin</title><body><h1>Grayboard admin</h1><p>The dashboard is not in this build yet.</p></body></html>`;

// `prefix`: the public URL's path ("" at the root), which a proxy may keep or strip, as the OAuth routes allow.
export function adminPage(req: Request, path: string, prefix: string): Response | undefined {
  const local = prefix && path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;
  if (local !== "/admin" && !local.startsWith("/admin/")) return undefined;
  const respond = (body: string | null, status: number, type?: string) =>
    new Response(body, { status, headers: { ...ADMIN_HEADERS, ...(type ? { "Content-Type": type } : {}) } });
  if (req.method !== "GET" && req.method !== "HEAD") return respond(null, 405);
  if (local === "/admin" || local === "/admin/" || local === "/admin/callback") return respond(req.method === "HEAD" ? null : PAGE, 200, "text/html; charset=utf-8");
  return respond("not found", 404, "text/plain; charset=utf-8");
}
