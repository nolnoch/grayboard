// The admin dashboard's page (#1651 D3, D4), served without a token: it holds no data, and signs in through the
// grayboard-admin OAuth client, whose one redirect is /admin/callback here. Every response under /admin carries
// ADMIN_HEADERS: same-origin scripts, styles and fetches only, so neither an inline script nor eval runs, no other
// site frames it, and no Referer carries the callback's code off the page.
//
// The markup, script and stylesheet are static: the script and stylesheet are files in ./admin/, imported as text so
// `bun build --compile` embeds them in the server binary. The page's markup has no inline script or style; the
// script builds every view with DOM APIs from the /api/admin/ read routes (admin_api.ts).
import script from "./admin/app.js" with { type: "text" };
import stylesheet from "./admin/app.css" with { type: "text" };

export const ADMIN_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ADMIN_HEADERS = {
  "Content-Security-Policy": ADMIN_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
};
// The nav's views, in the design's order: operations first (docs/future/admin-dashboard.md §Sequence).
const NAV = [["overview", "Overview"], ["users", "Users"], ["audit", "Audit"], ["boards", "Boards"], ["dms", "DMs"], ["claims", "Claims"], ["teams", "Teams"]];

// The markup for a public URL whose path is `prefix`: the assets' URLs are absolute, since the page answers at
// /admin, /admin/ and /admin/callback alike.
const page = (prefix: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Grayboard admin</title>
<link rel="stylesheet" href="${prefix}/admin/app.css">
<script type="module" src="${prefix}/admin/app.js"></script>
</head>
<body>
<header class="bar">
<span class="brand">grayboard<span>/admin</span></span>
<nav class="nav" id="nav">${NAV.map(([v, label]) => `<a href="#/${v}" data-view="${v}">${label}</a>`).join("")}</nav>
<span class="who" id="who" hidden><span>read-only</span><button type="button" id="signout">Sign out</button></span>
</header>
<main id="main"><p class="notice">Loading…</p></main>
<noscript><p class="notice">The dashboard needs JavaScript.</p></noscript>
</body>
</html>
`;

const ASSETS: Record<string, { body: string; type: string }> = {
  "/admin/app.js": { body: script, type: "text/javascript; charset=utf-8" },
  "/admin/app.css": { body: stylesheet, type: "text/css; charset=utf-8" },
};

// `prefix`: the public URL's path ("" at the root), which a proxy may keep or strip, as the OAuth routes allow.
export function adminPage(req: Request, path: string, prefix: string): Response | undefined {
  const local = prefix && path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;
  if (local !== "/admin" && !local.startsWith("/admin/")) return undefined;
  const head = req.method === "HEAD";
  const respond = (body: string | null, status: number, type?: string) =>
    new Response(head ? null : body, { status, headers: { ...ADMIN_HEADERS, ...(type ? { "Content-Type": type } : {}) } });
  if (req.method !== "GET" && !head) return respond(null, 405);
  if (local === "/admin" || local === "/admin/" || local === "/admin/callback") return respond(page(prefix), 200, "text/html; charset=utf-8");
  const asset = Object.hasOwn(ASSETS, local) ? ASSETS[local] : undefined;
  if (asset) return respond(asset.body, 200, asset.type);
  return respond("not found", 404, "text/plain; charset=utf-8");
}
