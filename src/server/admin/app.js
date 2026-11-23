// The admin dashboard's client (#1651, docs/future/admin-dashboard.md D4, D7, §Views). Plain browser JS, served
// same-origin at /admin/app.js under the page's CSP: no inline script, no eval, no third-party code.
//
// Sign-in: the server's own OAuth authorization-code flow with PKCE (S256) as the public client grayboard-admin, whose
// one redirect is <issuer>/admin/callback. The access token lives in sessionStorage (memory when that's refused); a 401
// clears it and signs in again, a 403 says the user isn't an admin. Rendering: every bus string reaches the DOM as a
// text node or an attribute value through DOM APIs, never as parsed markup (R1).
"use strict";

const CLIENT_ID = "grayboard-admin";
const SCOPE = "grayboard:admin";
const POLL_MS = 10_000;

// The page is served at <prefix>/admin, /admin/ or /admin/callback; the issuer is the public URL, prefix included.
const PAGE_PATH = /^(.*)\/admin(?:\/(?:callback)?)?$/.exec(location.pathname);
const BASE = location.origin + (PAGE_PATH ? PAGE_PATH[1] : "");
const ISSUER = BASE;
const REDIRECT = BASE + "/admin/callback";
const API = BASE + "/api/admin/";

// sessionStorage, or memory where the browser refuses it (a private window, blocked site data).
const store = (() => {
  const mem = new Map();
  const ss = () => { try { return window.sessionStorage; } catch { return null; } };
  return {
    get(k) { try { const v = ss()?.getItem(k); if (v != null) return v; } catch { /* memory */ } return mem.has(k) ? mem.get(k) : null; },
    set(k, v) { mem.set(k, v); try { ss()?.setItem(k, v); } catch { /* memory only */ } },
    del(k) { mem.delete(k); try { ss()?.removeItem(k); } catch { /* memory only */ } },
  };
})();
const K = { token: "gb-admin.token", pkce: "gb-admin.pkce", tried: "gb-admin.signin-at" };

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// h("td", { class: "mono", title: x }, child...): children are nodes or strings (text nodes), never markup.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = id => document.getElementById(id);
const link = (hash, text, cls) => h("a", { href: hash, class: cls }, text);
const chip = (text, kind) => h("span", { class: "chip" + (kind ? " " + kind : "") }, text);

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");
function when(ms) {
  if (ms == null) return "";
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function span(s) {
  s = Math.abs(Math.round(s));
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m`;
  if (s < 36 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
const ago = ms => ms == null ? "" : (Date.now() >= ms ? `${span((Date.now() - ms) / 1000)} ago` : `in ${span((ms - Date.now()) / 1000)}`);
const timeCell = ms => h("td", { class: "time", title: ago(ms) }, when(ms));
const ms3 = s => s == null ? "–" : `${(s * 1000).toFixed(s < 0.01 ? 2 : 1)} ms`;
const q = params => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? "?" + s : "";
};
const hashOf = (view, params = {}) => "#/" + view + q(params);

// ── sign-in ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

function token() {
  const raw = store.get(K.token);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw);
    if (typeof t.access_token === "string" && (!t.expires_at || t.expires_at > Date.now() + 5_000)) return t;
  } catch { /* fall through */ }
  store.del(K.token);
  return null;
}

async function signIn() {
  // A sign-in that comes straight back refused would loop: the second within 20 s stops and asks instead.
  const last = Number(store.get(K.tried) || 0);
  if (Date.now() - last < 20_000) {
    return fail("Sign-in didn't take", "The server refused the new token right after signing in. Check that this account is an admin and that the server's public URL matches this address.", true);
  }
  store.set(K.tried, String(Date.now()));
  const verifier = random(32), state = random(16);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  store.set(K.pkce, JSON.stringify({ verifier, state, back: location.hash || "" }));
  location.assign(ISSUER + "/oauth/authorize" + q({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, state,
    code_challenge: challenge, code_challenge_method: "S256",
  }));
  status("Signing in…");
}

// /admin/callback: check state and iss, take the code out of the URL, then redeem it.
async function callback() {
  const p = new URLSearchParams(location.search);
  let saved = null;
  try { saved = JSON.parse(store.get(K.pkce) || "null"); } catch { /* none */ }
  store.del(K.pkce);
  const back = saved && typeof saved.back === "string" && saved.back.startsWith("#/") ? saved.back : "#/overview";
  history.replaceState(null, "", BASE + "/admin" + back);
  if (p.get("error")) return fail("Sign-in refused", `${p.get("error")}${p.get("error_description") ? ": " + p.get("error_description") : ""}`, true);
  if (!saved || !p.get("state") || p.get("state") !== saved.state) return fail("Sign-in failed", "The sign-in's state didn't match this tab's. Start again from this tab.", true);
  if (p.get("iss") !== ISSUER) return fail("Sign-in failed", `The response came from issuer ${p.get("iss") ?? "(none)"}, not ${ISSUER}.`, true);
  const code = p.get("code");
  if (!code) return fail("Sign-in failed", "The response carried no code.", true);
  status("Signing in…");
  let res;
  try {
    res = await fetch(ISSUER + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, credentials: "omit",
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: saved.verifier, redirect_uri: REDIRECT }),
    });
  } catch (e) { return fail("Sign-in failed", `The token request failed: ${e.message}`, true); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.access_token !== "string") return fail("Sign-in failed", `The token endpoint answered ${res.status}${body.error ? ": " + body.error : ""}.`, true);
  store.set(K.token, JSON.stringify({ access_token: body.access_token, expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000 }));
  return true;
}

function signOut() {
  store.del(K.token);
  store.del(K.tried);
  stopPoll();
  generation++;
  current = null;
  $("who").hidden = true;
  $("main").replaceChildren(h("div", { class: "notice" }, h("strong", {}, "Signed out of this tab."),
    h("p", {}, "The server's sign-in session may still be live: signing in again may not ask."), h("button", { on: { click: () => { store.del(K.tried); signIn(); } } }, "Sign in")));
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
class Refused extends Error { constructor(status, body) { super(body?.message || `HTTP ${status}`); this.status = status; this.body = body; } }

async function api(route, params = {}) {
  const t = token();
  if (!t) { await signIn(); throw new Refused(401, { message: "signing in" }); }
  const res = await fetch(API + route + q(params), { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/json" }, credentials: "omit", cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (res.status === 401) { store.del(K.token); await signIn(); throw new Refused(401, body); }
  if (!res.ok) throw new Refused(res.status, body);
  store.del(K.tried);
  return body;
}

// ── shell ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function status(text) { $("main").replaceChildren(h("p", { class: "notice" }, text)); }
function fail(title, detail, retry) {
  stopPoll();
  $("main").replaceChildren(h("div", { class: "notice error" }, h("strong", {}, title), h("p", {}, detail),
    retry ? h("button", { on: { click: () => { store.del(K.tried); signIn(); } } }, "Sign in again") : null));
  return false;
}
function refusedNotice(e) {
  if (e.status === 403) {
    stopPoll();
    return h("div", { class: "notice error" }, h("strong", {}, "Not an admin"),
      h("p", {}, "This account signed in, but the server refused it the dashboard: only org admins can read it."),
      e.body?.message ? h("p", { class: "dim" }, e.body.message) : null,
      h("button", { on: { click: signOut } }, "Sign out"));
  }
  return h("div", { class: "notice error" }, h("strong", {}, e.status ? `Error ${e.status}` : "Request failed"), h("p", {}, e.message));
}

// ── list views ──────────────────────────────────────────────────────────────────────────────────────────────────────
// One keyset-paginated table. `params` are the route's filters, `cursor(next)` the next page's parameters from the
// route's `next`, `key` a row's identity and `cmp` the route's order: a poll re-reads the first page and merges it by
// key, so rows the operator paged in stay put.
function listView(spec) {
  return {
    rows: [], next: null, pages: 0, loading: false,
    async load() {
      const body = await api(spec.route, spec.params);
      this.rows = body.rows; this.next = body.next; this.pages = 1;
    },
    async poll() {
      const body = await api(spec.route, spec.params);
      if (this.pages <= 1) { this.rows = body.rows; this.next = body.next; return; }
      const byKey = new Map(this.rows.map(r => [spec.key(r), r]));
      for (const r of body.rows) byKey.set(spec.key(r), r);
      this.rows = [...byKey.values()].sort(spec.cmp);
    },
    async more() {
      const body = await api(spec.route, { ...spec.params, ...spec.cursor(this.next) });
      const seen = new Set(this.rows.map(spec.key));
      this.rows = this.rows.concat(body.rows.filter(r => !seen.has(spec.key(r))));
      this.next = body.next; this.pages++;
    },
    render() {
      const head = h("tr", {}, spec.columns.map(c => h("th", { class: c.num ? "num" : null }, c.h)));
      const rows = this.rows.length ? this.rows.map(r => h("tr", {}, spec.columns.map(c => {
        const v = c.f(r);
        const td = v instanceof Node && v.nodeName === "TD" ? v : h("td", { class: c.cls || null }, v);
        if (c.h) td.dataset.label = c.h;
        return td;
      }))) : [h("tr", {}, h("td", { class: "empty", colspan: spec.columns.length }, spec.empty || "Nothing here."))];
      const more = h("div", { class: "more" }, `${this.rows.length} shown`,
        this.next != null ? h("button", { on: { click: () => run(() => this.more()) } }, "Load more") : h("span", {}, "· end"));
      return [h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, head), h("tbody", {}, rows))), more];
    },
  };
}
// Several models shown as one view, each under its own heading.
function composite(parts) {
  return {
    async load() { await Promise.all(parts.map(x => x.model.load())); },
    async poll() { await Promise.all(parts.map(x => x.model.poll())); },
    render() { return parts.flatMap(x => [...(x.title ? [h("h2", {}, x.title)] : []), ...x.model.render()]); },
  };
}
function bindingsView(params) {
  return listView({
    route: "role-bindings", params, cursor: after => ({ after }), key: b => b.id ?? "bootstrap:" + b.principal,
    cmp: (a, b) => (a.id ?? -1) - (b.id ?? -1), empty: "No role bindings.",
    columns: [
      { h: "principal", f: b => h("td", { class: "mono ink" }, b.principal) },
      { h: "role", f: b => chip(b.role, b.role === "org_admin" ? "accent" : null) },
      { h: "scope", f: b => h("td", { class: "mono" }, b.scope ?? "org") },
      { h: "source", f: b => b.source === "bootstrap" ? h("span", { title: "GRAYBOARD_ADMINS" }, chip("bootstrap", "warn")) : chip("binding") },
      { h: "granted by", f: b => h("td", { class: "mono dim" }, b.granter ?? "") },
      { h: "granted", f: b => timeCell(b.granted_at) },
    ],
  });
}
function servicesView() {
  return listView({
    route: "service-list", params: {}, cursor: after => ({ after }), key: x => x.id, cmp: (a, b) => a.id - b.id, empty: "No service principals.",
    columns: [
      { h: "service", f: x => h("td", { class: "mono ink" }, x.name) },
      { h: "owners", f: x => h("td", { class: "mono wrap" }, x.owners.join(", ")) },
      { h: "state", f: x => x.disabled_at ? chip("disabled", "bad") : chip("active", "ok") },
      { h: "created", f: x => timeCell(x.created_at) },
      { h: "", f: x => h("td", { class: "nowrap" }, link(hashOf("audit", { actor: x.name }), "audit")) },
    ],
  });
}
const byIdDesc = (a, b) => b.id - a.id;
const byIdAsc = (a, b) => a.id - b.id;
const byKey = f => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);

// ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Each returns { title, crumbs, controls?, model }: the model loads, polls and renders.
const VIEWS = {
  overview() {
    let data = null;
    return {
      title: "Overview", nav: "overview",
      model: {
        async load() { data = (await api("overview")).rows[0]; }, poll() { return this.load(); },
        render() {
          if (!data) return [];
          const g = name => data.gauges.find(x => x.name === name);
          const sum = name => (g(name)?.values ?? []).reduce((n, v) => n + v.value, 0);
          const refusals = Object.entries(data.refusals);
          const refusedTotal = refusals.reduce((n, [, v]) => n + v, 0);
          const tile = (k, v, s, kind) => h("div", { class: "tile" }, h("div", { class: "k" }, k), h("div", { class: "v" + (kind ? " " + kind : "") }, v), s ? h("div", { class: "s" }, s) : null);
          return [
            h("div", { class: "tiles" },
              tile("health", data.health.ok ? "ok" : data.health.code || "failing", "/healthz", data.health.ok ? "ok" : "bad"),
              tile("version", data.version, `up ${span(data.uptime_s)}`),
              tile("sessions", String(sum("hosted_sessions_holding")), "hosted, bound"),
              tile("queue", String(data.queue_waiters), "write waiters"),
              tile("lag p50", ms3(data.lag?.p50), "last 10 s window"),
              tile("lag p99", ms3(data.lag?.p99), data.lag ? `max ${ms3(data.lag.max)}` : "no window yet"),
              tile("refusals", String(refusedTotal), "since start", refusedTotal ? "warn" : null),
              tile("slack", data.slack, "bridge", data.slack === "up" ? "ok" : data.slack === "down" ? "bad" : null)),
            h("div", { class: "grid2" },
              h("section", {}, h("h2", {}, "Refusals by kind"), table(["kind", "count#"], refusals.map(([k, v]) => [h("td", { class: "mono" }, k), h("td", { class: "num" }, String(v))]))),
              h("section", {}, h("h2", {}, "Gauges"), table(["gauge", "labels", "value#"], data.gauges.flatMap(x => x.values.map(v => [
                h("td", { class: "mono", title: x.help }, x.name),
                h("td", { class: "mono dim" }, v.labels ? Object.entries(v.labels).map(([a, b]) => `${a}=${b}`).join(" ") : ""),
                h("td", { class: "num" }, String(v.value))]))))),
          ];
        },
      },
    };
  },

  users() {
    const model = listView({
      route: "users", params: {}, cursor: after => ({ after }), key: u => u.id, cmp: byIdAsc,
      columns: [
        { h: "id", num: true, f: u => h("td", { class: "num" }, String(u.id)) },
        { h: "email", f: u => h("td", { class: "mono ink" }, u.kind === "user" ? link(hashOf("user", { email: u.email }), u.email) : u.email) },
        { h: "name", f: u => u.display_name ?? "", cls: "wrap" },
        { h: "kind", f: u => chip(u.kind, u.kind === "service" ? "accent" : null) },
        { h: "state", f: u => u.disabled_at ? h("span", { title: `disabled ${when(u.disabled_at)}` }, chip("disabled", "bad")) : chip("active", "ok") },
        { h: "identity", f: u => h("td", { class: "mono dim wrap", title: u.idp_subject ?? "" }, u.idp_issuer ?? "") },
        { h: "created", f: u => timeCell(u.created_at) },
        { h: "", f: u => h("td", { class: "nowrap" }, link(hashOf("audit", { actor: u.email }), "audit")) },
      ],
    });
    return {
      title: "Users", nav: "users", note: "Users and service principals in id order. Open a user for grants and roles.",
      model: composite([{ model }, { title: "Role bindings", model: bindingsView({}) }, { title: "Services", model: servicesView() }]),
    };
  },

  user(p) {
    const grants = listView({
      route: "user-grants", params: { email: p.email }, cursor: () => ({}), key: g => g.id, cmp: (a, b) => b.last_used_at - a.last_used_at,
      empty: "No live grants or CLI tokens.",
      columns: [
        { h: "kind", f: g => chip(g.kind, g.kind === "credential" ? "accent" : null) },
        { h: "client", f: g => h("td", { class: "mono ink" }, g.client_id ?? g.label ?? "") },
        { h: "last used", f: g => h("td", { class: "time", title: when(g.last_used_at) }, ago(g.last_used_at)) },
        { h: "created", f: g => timeCell(g.created_at) },
        { h: "expires", f: g => g.expires_at ? h("td", { class: "time", title: when(g.expires_at) }, ago(g.expires_at)) : h("td", { class: "dim" }, "idle limit") },
        { h: "id", f: g => h("td", { class: "mono dim wrap" }, g.id) },
      ],
    });
    const names = listView({
      route: "user-names", params: { email: p.email }, cursor: () => ({}), key: n => n.address,
      cmp: (a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0), empty: "No bound names.",
      columns: [
        { h: "name", f: n => h("td", { class: "mono ink" }, n.name) },
        { h: "session", f: n => n.held_by ? h("td", { class: "mono" }, chip("held", "ok"), " ", n.held_by) : h("td", { class: "dim" }, "free") },
        { h: "last seen", f: n => n.last_seen ? h("td", { class: "time", title: when(n.last_seen) }, ago(n.last_seen)) : h("td", { class: "dim" }, "never") },
        { h: "where", f: n => h("td", { class: "mono dim wrap" }, [n.place, n.cwd].filter(Boolean).join(" ")) },
      ],
    });
    return {
      title: p.email, nav: "users", crumbs: [link(hashOf("users"), "users")],
      controls: h("div", { class: "filters" }, link(hashOf("audit", { actor: p.email }), "audit rows by this user →")),
      note: "Bound names and the unended sessions holding them, sign-ins and roles.",
      model: composite([{ title: "Bound names", model: names }, { title: "Grants and CLI tokens", model: grants }, { title: "Role bindings", model: bindingsView({ principal: p.email }) }]),
    };
  },

  audit(p) {
    const filter = p.actor ? { actor: p.actor } : { action: p.action, target: p.action ? p.target : undefined };
    const model = listView({
      route: "audit", params: filter, cursor: c => ({ before_at: c.at, before_id: c.id }),
      key: r => r.id, cmp: (a, b) => b.at - a.at || b.id - a.id,
      columns: [
        { h: "at", f: r => timeCell(r.at) },
        { h: "actor", f: r => h("td", { class: "mono ink nowrap" }, r.actor ? link(hashOf("audit", { actor: r.actor }), r.actor) : h("span", { class: "dim" }, "–")) },
        { h: "action", f: r => h("td", { class: "mono nowrap" }, link(hashOf("audit", { action: r.action }), r.action)) },
        { h: "target", f: r => h("td", { class: "mono wrap" }, r.target ? link(hashOf("audit", { action: r.action, target: r.target }), r.target) : "") },
        { h: "detail", f: r => h("td", { class: "detail" }, detail(r.detail)) },
        { h: "client", f: r => h("td", { class: "mono dim nowrap" }, r.client_id ?? "") },
        { h: "ip", f: r => h("td", { class: "mono dim nowrap", title: r.ua ?? "" }, r.ip ?? "") },
      ],
    });
    const field = (name, label, value, disabled) => h("label", {}, label, h("input", { name, value: value ?? "", spellcheck: "false", autocomplete: "off", disabled }));
    const form = h("form", { class: "filters", on: { submit: e => {
      e.preventDefault();
      const f = new FormData(e.target), get = k => (f.get(k) || "").toString().trim();
      go(hashOf("audit", get("actor") ? { actor: get("actor") } : { action: get("action"), target: get("action") ? get("target") : "" }));
    } } },
      field("action", "action", p.action), field("target", "target", p.target), field("actor", "actor", p.actor),
      h("button", { type: "submit" }, "Filter"), (p.action || p.actor) ? link(hashOf("audit"), "clear") : null,
      h("span", { class: "hint" }, "actor alone, or action (with target)"));
    return { title: "Audit log", nav: "audit", model, controls: form, note: "access_log, newest first." };
  },

  boards() {
    const model = listView({
      route: "boards", params: {}, cursor: after => ({ after }), key: b => b.name, cmp: byKey(b => b.name),
      columns: [
        { h: "board", f: b => h("td", { class: "mono ink nowrap" }, link(hashOf("threads", { board: b.name }), b.name)) },
        { h: "purpose", f: b => b.purpose, cls: "wrap" },
        { h: "scope", f: b => h("td", { class: "mono dim" }, b.scope ?? "org") },
        { h: "kind", f: b => b.kind ? chip(b.kind) : "" },
        { h: "state", f: b => b.archived_at ? h("span", { title: `by ${b.archived_by ?? "?"} at ${when(b.archived_at)}` }, chip("archived", "warn")) : chip("open", "ok") },
        { h: "created by", f: b => h("td", { class: "mono" }, b.created_by) },
        { h: "created", f: b => timeCell(b.created_at) },
      ],
    });
    return { title: "Boards", nav: "boards", model, note: "By name." };
  },

  threads(p) {
    const model = listView({
      route: "threads", params: { board: p.board }, cursor: before => ({ before }), key: t => t.id, cmp: byIdDesc,
      empty: "No threads on this board.",
      columns: [
        { h: "root", num: true, f: t => h("td", { class: "num" }, link(hashOf("thread", { root: t.id, board: p.board }), `#${t.id}`)) },
        { h: "author", f: t => h("td", { class: "mono ink" }, t.author) },
        { h: "started", f: t => timeCell(t.created_at) },
        { h: "", f: t => h("td", { class: "nowrap" }, link(hashOf("thread", { root: t.id, board: p.board }), "read")) },
      ],
    });
    return { title: `#${p.board}`, nav: "boards", crumbs: [link(hashOf("boards"), "boards")], model, note: "Threads, newest first. Opening one is audited." };
  },

  thread(p) {
    const root = Number(p.root);
    let posts = [], next = null, done = false;
    const model = {
      async load() { const b = await api("thread", { root }); posts = b.rows; next = b.next; done = b.next == null; },
      async more() { const b = await api("thread", { root, after: next }); posts = posts.concat(b.rows); next = b.next; done = b.next == null; },
      // Only at the end of the thread: new replies arrive after the last post read.
      async poll() {
        if (!done || !posts.length) return posts.length ? undefined : this.load();
        const b = await api("thread", { root, after: posts[posts.length - 1].id });
        posts = posts.concat(b.rows); next = b.next; done = b.next == null;
      },
      render() {
        if (!posts.length) return [h("div", { class: "notice" }, "This thread is gone: its root was removed, by retention or archive.")];
        const depth = new Map();
        const out = [];
        if (posts[0].id !== root) out.push(h("div", { class: "gap" }, "Older posts removed by retention."));
        for (const post of posts) {
          const d = post.parent_id == null ? 0 : Math.min(5, (depth.get(post.parent_id) ?? 0) + 1);
          depth.set(post.id, d);
          out.push(h("article", { class: `post${post.id === root ? " root" : ""}${d ? " d" + d : ""}`, id: `p${post.id}` },
            h("div", { class: "ph" }, h("span", { class: "author" }, post.author), h("span", {}, `#${post.id}`),
              post.parent_id != null && post.parent_id !== root ? h("span", {}, `↳ #${post.parent_id}`) : null,
              h("span", { title: ago(post.created_at) }, when(post.created_at))),
            h("div", { class: "body" }, post.body)));
        }
        return [h("div", { class: "posts" }, out),
          h("div", { class: "more" }, `${posts.length} posts`, next != null ? h("button", { on: { click: () => run(() => model.more()) } }, "Load more") : h("span", {}, "· end")),
        ];
      },
    };
    const board = p.board || (posts[0] && posts[0].board) || "";
    return { title: `Thread #${root}`, nav: "boards", crumbs: [link(hashOf("boards"), "boards"), board ? link(hashOf("threads", { board }), `#${board}`) : null], model, note: "Audited read." };
  },

  dms() {
    const model = listView({
      route: "messages", params: {}, cursor: before => ({ before }), key: m => m.id, cmp: byIdDesc,
      columns: [
        { h: "id", num: true, f: m => h("td", { class: "num" }, String(m.id)) },
        { h: "from", f: m => h("td", { class: "mono ink" }, m.sender) },
        { h: "to", f: m => h("td", { class: "mono ink" }, m.recipient_type === "team" ? h("span", {}, chip("team", "accent"), " ", m.recipient) : m.recipient) },
        { h: "reply to", f: m => h("td", { class: "num dim" }, m.parent_id != null ? `#${m.parent_id}` : "") },
        { h: "sent", f: m => timeCell(m.created_at) },
        { h: "delivery", f: m => m.delivered_at ? h("span", { title: `delivered ${when(m.delivered_at)}` }, chip("delivered", "ok")) : m.pending ? chip("pending", "warn") : chip("queued") },
        { h: "kind", f: m => m.kind ? chip(m.kind, "warn") : "" },
        { h: "", f: m => h("td", { class: "nowrap" }, m.recipient_type === "user" ? link(hashOf("conversation", { a: m.sender, b: m.recipient }), "read") : "") },
      ],
    });
    return { title: "Direct messages", nav: "dms", model, note: "Newest first, without bodies. Opening a conversation is audited." };
  },

  conversation(p) {
    const model = listView({
      route: "conversation", params: { a: p.a, b: p.b }, cursor: before => ({ before }), key: m => m.id, cmp: byIdDesc,
      columns: [],
    });
    // Rendered as cards, newest first, with delivery state.
    model.render = function () {
      if (!this.rows.length) return [h("div", { class: "notice" }, "No direct messages between these two.")];
      return [h("div", { class: "posts" }, this.rows.map(m => h("article", { class: "post" },
        h("div", { class: "ph" }, h("span", { class: "author" }, m.sender), h("span", {}, `→ ${m.recipient}`), h("span", {}, `#${m.id}`),
          m.parent_id != null ? h("span", {}, `↳ #${m.parent_id}`) : null,
          h("span", { title: ago(m.created_at) }, when(m.created_at)),
          m.delivered_at ? chip("delivered", "ok") : m.pending ? chip("pending", "warn") : chip("queued"),
          m.kind ? chip(m.kind, "warn") : null,
          m.attachments?.length ? chip(`${m.attachments.length} file${m.attachments.length > 1 ? "s" : ""}`, "accent") : null),
        h("div", { class: "body" }, m.body)))),
        h("div", { class: "more" }, `${this.rows.length} shown`, this.next != null ? h("button", { on: { click: () => run(() => this.more()) } }, "Load more") : h("span", {}, "· end"))];
    };
    return { title: `${p.a} ↔ ${p.b}`, nav: "dms", crumbs: [link(hashOf("dms"), "direct messages")], model, note: "Newest first. Audited read." };
  },

  claims() {
    const model = listView({
      route: "claims", params: {}, cursor: after => ({ after }), key: c => c.key, cmp: byKey(c => c.key),
      empty: "No claims held.",
      columns: [
        { h: "key", f: c => h("td", { class: "mono ink" }, link(hashOf("claim", { key: c.key }), c.key)) },
        { h: "holder", f: c => h("td", { class: "mono" }, c.holder) },
        { h: "note", f: c => c.note ?? "", cls: "wrap" },
        { h: "board", f: c => h("td", { class: "mono" }, c.board ? link(hashOf("threads", { board: c.board }), "#" + c.board) : "") },
        { h: "acquired", f: c => timeCell(c.acquired_at) },
        { h: "expires", f: c => h("td", { class: "time", title: when(c.expires_at) }, ago(c.expires_at)) },
      ],
    });
    return { title: "Claims", nav: "claims", model, note: "Live claims by key." };
  },

  claim(p) {
    const model = listView({
      route: "claim-events", params: { key: p.key }, cursor: before => ({ before }), key: e => e.id, cmp: byIdDesc,
      empty: "No history for this key (retention prunes it).",
      columns: [
        { h: "at", f: e => timeCell(e.at) },
        { h: "event", f: e => chip(e.event, { take: "ok", renew: "ok", refused: "bad", expire: "warn" }[e.event] || null) },
        { h: "by", f: e => h("td", { class: "mono ink" }, e.handle) },
        { h: "held by", f: e => h("td", { class: "mono" }, e.held_by ?? "") },
        { h: "note", f: e => e.note ?? "", cls: "wrap" },
        { h: "board", f: e => h("td", { class: "mono" }, e.board ?? "") },
        { h: "expires", f: e => timeCell(e.expires_at) },
      ],
    });
    return { title: p.key, nav: "claims", crumbs: [link(hashOf("claims"), "claims")], model, note: "History, newest first." };
  },

  teams() {
    const model = listView({
      route: "teams", params: {}, cursor: after => ({ after }), key: t => t.id, cmp: byIdAsc,
      empty: "No teams.",
      columns: [
        { h: "id", num: true, f: t => h("td", { class: "num" }, String(t.id)) },
        { h: "team", f: t => h("td", { class: "mono ink" }, link(hashOf("team", { name: t.name }), t.name)) },
        { h: "policy", f: t => h("td", { class: "mono" }, t.policy) },
        { h: "created by", f: t => h("td", { class: "num dim" }, `user ${t.created_by}`) },
        { h: "created", f: t => timeCell(t.created_at) },
      ],
    });
    return { title: "Teams", nav: "teams", model, note: "By id." };
  },

  team(p) {
    let data = null;
    return {
      title: p.name, nav: "teams", crumbs: [link(hashOf("teams"), "teams")],
      model: {
        async load() { data = (await api("team", { name: p.name })).rows[0] ?? null; }, poll() { return this.load(); },
        render() {
          if (!data) return [h("div", { class: "notice" }, "No such team.")];
          return [
            h("dl", { class: "kv" }, h("dt", {}, "id"), h("dd", {}, String(data.team.id)), h("dt", {}, "policy"), h("dd", {}, data.team.policy),
              h("dt", {}, "created"), h("dd", {}, when(data.team.created_at))),
            h("div", { class: "grid2" },
              h("section", {}, h("h2", {}, `Members (${data.members.length})`), table(["email", "role"], data.members.map(m => [
                h("td", { class: "mono ink" }, link(hashOf("audit", { actor: m.email }), m.email)), h("td", {}, chip(m.role, m.role === "owner" ? "accent" : null))]))),
              h("section", {}, h("h2", {}, `Aliases (${data.aliases.length})`), table(["name", "address", "created"], data.aliases.map(a => [
                h("td", { class: "mono ink" }, a.name), h("td", { class: "mono" }, a.address), timeCell(a.created_at)])))),
          ];
        },
      },
    };
  },
};

// A small table; a header ending in "#" is a numeric column (right-aligned), shown without the mark.
function table(headers, rows) {
  const names = headers.map(x => x.replace(/#$/, ""));
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, headers.map((x, i) => h("th", { class: x.endsWith("#") ? "num" : null }, names[i])))),
    h("tbody", {}, rows.length ? rows.map(r => h("tr", {}, r.map((td, i) => { td.dataset.label = names[i]; return td; })))
      : h("tr", {}, h("td", { class: "empty", colspan: headers.length }, "None.")))));
}

// An audit row's detail: its JSON object as key=value pairs, each pair kept whole; anything else as its text.
function detail(text) {
  if (!text) return "";
  let o;
  try { o = JSON.parse(text); } catch { return text; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return text;
  return Object.entries(o).map(([k, v]) => h("span", { class: "pair" }, h("span", { class: "k" }, k), "=", typeof v === "string" ? v : JSON.stringify(v)));
}

// ── router and polling ──────────────────────────────────────────────────────────────────────────────────────────────
let current = null, timer = null, generation = 0, lastOk = 0;

function parseHash() {
  const m = /^#\/([a-z-]+)(?:\?(.*))?$/.exec(location.hash);
  const view = m && Object.hasOwn(VIEWS, m[1]) ? m[1] : "overview";
  return { view, params: Object.fromEntries(new URLSearchParams(m?.[2] || "")) };
}
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function paint() {
  if (!current) return;
  const v = current.view;
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.dataset.view === v.nav) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  const meta = h("span", { class: "meta" + (lastOk && Date.now() - lastOk > 3 * POLL_MS ? " stale" : "") }, lastOk ? `updated ${when(lastOk).slice(11)}` : "");
  const head = h("div", { class: "head" },
    v.crumbs ? h("span", { class: "crumbs" }, v.crumbs.filter(Boolean).flatMap((c, i) => i ? [" / ", c] : [c]), " /") : null,
    h("h1", {}, v.title), v.note ? h("span", { class: "hint" }, v.note) : null, meta,
    h("button", { title: "Reload from the first page", on: { click: () => route() } }, "Refresh"));
  let body;
  try { body = v.model.render(); } catch (e) { body = [refusedNotice(e)]; }
  $("main").replaceChildren(...[head, v.controls, current.error ? refusedNotice(current.error) : null, ...body].filter(x => x != null));
  document.title = `${v.title} · Grayboard admin`;
}

// Runs a model step for the current view, then repaints; a stale step (the view changed under it) is dropped.
async function run(step) {
  const gen = generation;
  try {
    await step();
    if (gen !== generation) return;
    current.error = null; lastOk = Date.now();
  } catch (e) {
    if (gen !== generation) return;
    if (e instanceof Refused && e.status === 401) return;
    current.error = e;
  }
  paint();
}

async function route() {
  const { view, params } = parseHash();
  generation++;
  stopPoll();
  current = { view: VIEWS[view](params), error: null };
  lastOk = 0;
  status("Loading…");
  await run(() => current.view.model.load());
  startPoll();
}

function startPoll() {
  stopPoll();
  timer = setInterval(() => {
    if (document.hidden || !current || current.error?.status === 403) return;
    run(() => current.view.model.poll());
  }, POLL_MS);
}
function stopPoll() { if (timer) clearInterval(timer); timer = null; }

// A tab coming back to the front catches up at once rather than waiting out the interval.
document.addEventListener("visibilitychange", () => { if (!document.hidden && current && timer) run(() => current.view.model.poll()); });
window.addEventListener("hashchange", () => route());

async function main() {
  $("signout").addEventListener("click", signOut);
  if (/\/admin\/callback$/.test(location.pathname)) { if (!await callback()) return; }
  if (!token()) return signIn();
  $("who").hidden = false;
  route();
}
main();
