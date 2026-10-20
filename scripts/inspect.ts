#!/usr/bin/env bun
// Local, read-only web view of a local-mode bus database: boards and their
// threads, DM conversations, handles, claims and their history, and search.
//
//   bun scripts/inspect.ts [--db PATH] [--port N]
//
// Serves http://127.0.0.1:<port> (default 4777), bound to loopback only. The
// database is opened read-only; WAL lets it read alongside live sessions, and
// each request sees the latest commits. Reload the page to refresh.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: process.env.BUS_DB_PATH ?? join(homedir(), ".claude-bus/bus.db") },
    port: { type: "string", default: "4777" },
  },
});

if (!existsSync(args.db!)) throw new Error(`no bus database at ${args.db}`);
const db = new Database(args.db!, { readonly: true });
db.exec("PRAGMA busy_timeout = 5000");

const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p);
const DAY = 86_400_000;

// ── API ─────────────────────────────────────────────────────────────────────

function overview() {
  const since = Date.now() - 30 * DAY;
  return {
    db: args.db,
    totals: db.prepare(`SELECT
        (SELECT COUNT(*) FROM boards)   AS boards,
        (SELECT COUNT(*) FROM posts)    AS posts,
        (SELECT COUNT(*) FROM messages) AS dms,
        (SELECT COUNT(*) FROM handles)  AS handles,
        (SELECT COUNT(*) FROM claims)   AS claims`).get(),
    boards: all(`SELECT b.name, b.purpose, b.scope, b.created_by, b.created_at,
        COUNT(p.id) AS posts, MAX(p.created_at) AS last_post,
        SUM(p.parent_id IS NULL) AS threads,
        (SELECT COUNT(*) FROM subscriptions s WHERE s.board = b.name) AS subscribers
      FROM boards b LEFT JOIN posts p ON p.board = b.name
      GROUP BY b.name ORDER BY last_post DESC`),
    handles: all(`SELECT h.name, h.first_seen, h.last_seen, h.cwd, h.place, h.status, h.status_at, h.human,
        (SELECT COUNT(*) FROM posts WHERE author = h.name)       AS posts,
        (SELECT COUNT(*) FROM messages WHERE sender = h.name)    AS dms_sent,
        (SELECT COUNT(*) FROM messages WHERE recipient = h.name) AS dms_recv
      FROM handles h ORDER BY h.last_seen DESC`),
    // Per-day activity for the last 30 days, local time.
    daily: all(`SELECT day, SUM(kind = 'post') AS posts, SUM(kind = 'dm') AS dms FROM (
        SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, 'post' AS kind FROM posts WHERE created_at >= ?1
        UNION ALL
        SELECT date(created_at / 1000, 'unixepoch', 'localtime'), 'dm' FROM messages WHERE created_at >= ?1
      ) GROUP BY day ORDER BY day`, since),
  };
}

function board(name: string) {
  return {
    board: db.prepare(`SELECT * FROM boards WHERE name = ?`).get(name),
    posts: all(`SELECT id, author, body, parent_id, created_at, expires_at FROM posts WHERE board = ? ORDER BY id`, name),
    subscriptions: all(`SELECT handle, mode, cursor FROM subscriptions WHERE board = ? ORDER BY handle`, name),
  };
}

// Conversations are unordered handle pairs.
function conversations() {
  return all(`SELECT MIN(sender, recipient) AS a, MAX(sender, recipient) AS b,
      COUNT(*) AS messages, MAX(created_at) AS last_at, SUM(pending) AS pending
    FROM messages GROUP BY a, b ORDER BY last_at DESC`);
}

function conversation(a: string, b: string) {
  return all(`SELECT m.id, m.sender, m.recipient, m.body, m.parent_id, m.created_at, m.pending,
      k.acked_at
    FROM messages m LEFT JOIN dm_acks k ON k.message_id = m.id AND k.reader = m.recipient
    WHERE (m.sender = ?1 AND m.recipient = ?2) OR (m.sender = ?2 AND m.recipient = ?1)
    ORDER BY m.id`, a, b);
}

function claims() {
  return {
    active: all(`SELECT * FROM claims ORDER BY acquired_at DESC`),
    events: all(`SELECT * FROM claim_events ORDER BY id DESC LIMIT 500`),
  };
}

function search(q: string) {
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  return {
    posts: all(`SELECT id, board, author, body, parent_id, created_at FROM posts
      WHERE body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 200`, like),
    dms: all(`SELECT id, sender, recipient, body, created_at FROM messages
      WHERE body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 200`, like),
  };
}

function api(url: URL): unknown {
  const q = (k: string) => url.searchParams.get(k) ?? "";
  switch (url.pathname) {
    case "/api/overview":      return overview();
    case "/api/board":         return board(q("name"));
    case "/api/conversations": return conversations();
    case "/api/conversation":  return conversation(q("a"), q("b"));
    case "/api/claims":        return claims();
    case "/api/search":        return search(q("q"));
  }
  return undefined;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args.port),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    const body = api(url);
    return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
  },
});
console.log(`grayboard inspect: ${server.url} (${args.db}, read-only)`);

// ── page ────────────────────────────────────────────────────────────────────

const PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grayboard Inspector</title>
<style>
:root { --bg:#fafaf9; --panel:#fff; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --accent:#2563eb; --chip:#f5f5f4; --warn:#b45309; --mine:#eff6ff; }
@media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --panel:#1c1917; --fg:#e7e5e4; --muted:#a8a29e; --line:#292524; --accent:#60a5fa; --chip:#292524; --warn:#fbbf24; --mine:#172033; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; }
header { position:sticky; top:0; z-index:1; display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
header b { font-size:15px; }
nav a, a { color:var(--accent); text-decoration:none; }
nav { display:flex; gap:14px; }
nav a.on { font-weight:600; text-decoration:underline; }
header form { margin-left:auto; }
input[type=search] { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; width:220px; max-width:60vw; }
main { max-width:1100px; margin:0 auto; padding:16px; }
h2 { font-size:16px; margin:24px 0 8px; }
.muted { color:var(--muted); }
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px; }
.tile { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
.tile .n { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
.scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:12px; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.chip { display:inline-block; background:var(--chip); border-radius:4px; padding:0 6px; font-size:12px; color:var(--muted); }
.chip.warn { color:var(--warn); }
.thread { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin:10px 0; }
.post { padding:8px 12px; border-top:1px solid var(--line); }
.post:first-child { border-top:none; }
.post.reply { margin-left:24px; }
.meta { font-size:12px; color:var(--muted); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.meta .who { color:var(--fg); font-weight:600; }
.body { white-space:pre-wrap; overflow-wrap:anywhere; margin-top:2px; }
.dm { max-width:80%; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:8px 0; }
.dm.right { margin-left:auto; background:var(--mine); }
.bars { display:flex; align-items:flex-end; gap:2px; height:80px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px; }
.bars div { flex:1; display:flex; flex-direction:column-reverse; min-width:3px; }
.bars span { display:block; }
.bars .p { background:var(--accent); }
.bars .d { background:var(--muted); }
.legend { font-size:12px; color:var(--muted); margin-top:4px; }
.legend i { display:inline-block; width:10px; height:10px; margin:0 4px 0 10px; vertical-align:middle; }
/* Print light whatever the OS scheme, without the header, and keep each post or DM whole. */
@media print {
  :root { --bg:#fff; --panel:#fff; --fg:#1c1917; --muted:#57534e; --line:#d6d3d1; --accent:#1d4ed8; --chip:#f5f5f4; --warn:#b45309; --mine:#eff6ff; }
  * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  header { display:none; }
  main { max-width:none; padding:0; }
  .post, .dm, tr, .tile { break-inside:avoid; }
  h2 { break-after:avoid; }
}
</style></head>
<body>
<header><b>grayboard</b>
<nav><a href="#/">Overview</a><a href="#/dms">DMs</a><a href="#/claims">Claims</a></nav>
<form id="sf"><input type="search" id="sq" placeholder="Search posts and DMs"></form>
</header>
<main id="app"></main>
<script>
const app = document.getElementById("app");
const get = (path) => fetch(path).then((r) => r.json());
const enc = encodeURIComponent;
const fmt = (ms) => ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
function ago(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
// Build DOM from [tag, attrs, ...children]; strings become text nodes, so bus
// content is never parsed as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const chip = (t, cls) => h("span", { class: "chip " + (cls || "") }, t);
const link = (href, t) => h("a", { href }, t);
const handleLink = (n) => link("#/handle/" + enc(n), n);
function table(cols, rows) {
  return h("div", { class: "scroll" }, h("table", {},
    h("tr", {}, cols.map(([label, , num]) => h("th", { class: num ? "num" : null }, label))),
    rows.map((r) => h("tr", {}, cols.map(([, f, num]) => h("td", { class: num ? "num" : null }, f(r)))))));
}
function render(...nodes) { app.replaceChildren(...nodes.flat()); window.scrollTo(0, 0); }

function bars(daily) {
  if (!daily.length) return h("p", { class: "muted" }, "No activity in the last 30 days.");
  const max = Math.max(...daily.map((d) => d.posts + d.dms));
  return [
    h("div", { class: "bars" }, daily.map((d) => h("div", { title: d.day + ": " + d.posts + " posts, " + d.dms + " DMs" },
      h("span", { class: "p", style: "height:" + (d.posts / max * 64) + "px" }),
      h("span", { class: "d", style: "height:" + (d.dms / max * 64) + "px" })))),
    h("div", { class: "legend" }, daily[0].day + " → " + daily[daily.length - 1].day,
      h("i", { class: "", style: "background:var(--accent)" }), "posts", h("i", { style: "background:var(--muted)" }), "DMs"),
  ];
}

async function overview() {
  const o = await get("/api/overview");
  const t = o.totals;
  render(
    h("div", { class: "tiles" }, [["Boards", t.boards], ["Posts", t.posts], ["DMs", t.dms], ["Handles", t.handles], ["Active claims", t.claims]]
      .map(([k, n]) => h("div", { class: "tile" }, h("div", { class: "muted" }, k), h("div", { class: "n" }, n)))),
    h("h2", {}, "Activity, last 30 days"), bars(o.daily),
    h("h2", {}, "Boards"),
    table([
      ["Board", (b) => link("#/board/" + enc(b.name), "#" + b.name)],
      ["Purpose", (b) => [b.purpose, b.scope ? [" ", chip("scope: " + b.scope)] : null]],
      ["Threads", (b) => b.threads ?? 0, 1], ["Posts", (b) => b.posts, 1], ["Subs", (b) => b.subscribers, 1],
      ["Last post", (b) => ago(b.last_post)], ["Created", (b) => [b.created_by, " · ", fmt(b.created_at)]],
    ], o.boards),
    h("h2", {}, "Handles"),
    table([
      ["Handle", (x) => [handleLink(x.name), x.human ? [" ", chip("human")] : null]],
      ["Status", (x) => x.status ? [x.status, " ", h("span", { class: "muted" }, ago(x.status_at))] : ""],
      ["Where", (x) => h("span", { class: "muted" }, x.cwd || x.place || "")],
      ["Posts", (x) => x.posts, 1], ["DMs out", (x) => x.dms_sent, 1], ["DMs in", (x) => x.dms_recv, 1],
      ["Last seen", (x) => ago(x.last_seen)],
    ], o.handles),
    h("p", { class: "muted" }, o.db + " · read-only · reload to refresh"),
  );
}

// Group posts into threads by root; a thread sorts by its latest activity.
function threads(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const rootOf = (p) => { let r = p; while (r.parent_id && byId.has(r.parent_id)) r = byId.get(r.parent_id); return r.id; };
  const groups = new Map();
  for (const p of posts) { const r = rootOf(p); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); }
  return [...groups.values()].sort((a, b) => b[b.length - 1].id - a[a.length - 1].id);
}
function postEl(p, root, showBoard) {
  return h("div", { class: "post" + (p.id === root ? "" : " reply"), id: "p" + p.id },
    h("div", { class: "meta" }, h("span", { class: "who" }, p.author), showBoard ? link("#/board/" + enc(p.board), "#" + p.board) : null,
      h("span", {}, fmt(p.created_at)), h("span", {}, "#" + p.id),
      p.parent_id && p.parent_id !== root ? chip("↳ " + p.parent_id) : null,
      p.expires_at ? chip("expires " + fmt(p.expires_at), "warn") : null),
    h("div", { class: "body" }, p.body));
}
async function boardView(name) {
  const d = await get("/api/board?name=" + enc(name));
  if (!d.board) return render(h("p", {}, "No board #" + name));
  const ts = threads(d.posts);
  render(
    h("h2", {}, "#" + name), h("p", {}, d.board.purpose),
    h("p", { class: "muted" }, d.posts.length + " posts in " + ts.length + " threads · created by " + d.board.created_by + " " + fmt(d.board.created_at)),
    d.subscriptions.length ? h("p", {}, "Subscribers: ", d.subscriptions.map((s) => [chip(s.handle + " · " + s.mode), " "])) : null,
    ts.map((t) => h("div", { class: "thread" }, t.map((p) => postEl(p, t[0].id)))),
  );
}

async function dmsView() {
  const cs = await get("/api/conversations");
  render(h("h2", {}, "DM conversations"), table([
    ["Between", (c) => link("#/dm/" + enc(c.a) + "/" + enc(c.b), c.a + " ↔ " + c.b)],
    ["Messages", (c) => c.messages, 1], ["Pending", (c) => c.pending || "", 1], ["Last", (c) => ago(c.last_at)],
  ], cs));
}
async function conversationView(a, b) {
  const ms = await get("/api/conversation?a=" + enc(a) + "&b=" + enc(b));
  render(h("h2", {}, a + " ↔ " + b), h("p", { class: "muted" }, ms.length + " messages; " + b + " on the right"),
    ms.map((m) => h("div", { class: "dm" + (m.sender === b ? " right" : ""), id: "m" + m.id },
      h("div", { class: "meta" }, h("span", { class: "who" }, m.sender), h("span", {}, fmt(m.created_at)), h("span", {}, "#" + m.id),
        m.parent_id ? chip("↳ " + m.parent_id) : null, m.pending ? chip("owes follow-up", "warn") : null,
        m.acked_at ? chip("acked " + fmt(m.acked_at)) : null),
      h("div", { class: "body" }, m.body))));
}

async function handleView(name) {
  const [o, cs] = await Promise.all([get("/api/overview"), get("/api/conversations")]);
  const x = o.handles.find((y) => y.name === name);
  if (!x) return render(h("p", {}, "No handle " + name));
  render(h("h2", {}, name, x.human ? [" ", chip("human")] : null),
    h("p", {}, x.status || h("span", { class: "muted" }, "no status")),
    h("p", { class: "muted" }, (x.cwd || x.place || "") + " · first seen " + fmt(x.first_seen) + " · last seen " + ago(x.last_seen)),
    h("h2", {}, "Conversations"),
    table([
      ["With", (c) => link("#/dm/" + enc(name) + "/" + enc(c.a === name ? c.b : c.a), c.a === name ? c.b : c.a)],
      ["Messages", (c) => c.messages, 1], ["Last", (c) => ago(c.last_at)],
    ], cs.filter((c) => c.a === name || c.b === name)));
}

async function claimsView() {
  const c = await get("/api/claims");
  render(h("h2", {}, "Active claims"),
    c.active.length ? table([
      ["Key", (r) => r.key], ["Holder", (r) => handleLink(r.holder)], ["Note", (r) => r.note || ""],
      ["Board", (r) => r.board ? link("#/board/" + enc(r.board), "#" + r.board) : ""],
      ["Taken", (r) => fmt(r.acquired_at)], ["Expires", (r) => fmt(r.expires_at)],
    ], c.active) : h("p", { class: "muted" }, "None."),
    h("h2", {}, "History"),
    c.events.length ? table([
      ["When", (r) => fmt(r.at)], ["Event", (r) => chip(r.event, r.event === "refused" ? "warn" : "")], ["Key", (r) => r.key],
      ["Handle", (r) => handleLink(r.handle)], ["Held by", (r) => r.held_by || ""], ["Note", (r) => r.note || ""],
    ], c.events) : h("p", { class: "muted" }, "None."));
}

async function searchView(q) {
  const r = await get("/api/search?q=" + enc(q));
  render(h("h2", {}, "Search: " + q),
    h("h2", {}, "Posts (" + r.posts.length + ")"),
    h("div", { class: "thread" }, r.posts.map((p) => postEl(p, p.id, true))),
    h("h2", {}, "DMs (" + r.dms.length + ")"),
    r.dms.map((m) => h("div", { class: "dm" },
      h("div", { class: "meta" }, link("#/dm/" + enc(m.sender) + "/" + enc(m.recipient), m.sender + " → " + m.recipient),
        h("span", {}, fmt(m.created_at)), h("span", {}, "#" + m.id)),
      h("div", { class: "body" }, m.body))));
}

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("on", a.getAttribute("href") === "#/" + (parts[0] === "dm" ? "dms" : parts[0]));
  const views = {
    "": overview, board: () => boardView(parts[1]), dms: dmsView, dm: () => conversationView(parts[1], parts[2]),
    handle: () => handleView(parts[1]), claims: claimsView, search: () => searchView(parts.slice(1).join("/")),
  };
  (views[parts[0]] || overview)().catch((e) => render(h("p", { class: "chip warn" }, String(e))));
}
document.getElementById("sf").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("sq").value.trim();
  if (q) location.hash = "#/search/" + enc(q);
});
addEventListener("hashchange", route);
route();
</script></body></html>`;
