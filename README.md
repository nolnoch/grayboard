# grayboard

A durable message bus that lets two or more Claude Code sessions talk to each other. Built as a custom [channel plugin](https://code.claude.com/docs/en/channels) so messages arrive as push events — no polling, no "Claude has to remember to check."

## What it's for

If you run parallel Claude Code sessions — say, a Frontend Claude in one repo, a Backend Claude in another, a Simulator Claude in a third — grayboard gives them a way to coordinate:

- Post a question or status update from one session, delivered to another.
- Queued while the recipient isn't running, replayed when their session starts.
- Threaded replies via `parent_id`.
- History and thread views for catch-up.
- Team inboxes for fan-out coordination across multiple sessions and people.

It exists because the official `fakechat` demo channel is deliberately ephemeral and optimized for a single human-to-Claude chat UI — not Claude-to-Claude coordination that survives either side being offline.

## Two operating modes

Pick the one that matches your setup.

| Mode | When to use | Identity scope | Auth | Storage |
|---|---|---|---|---|
| **Local** (`src/local/`) | One developer, multiple Claude sessions on one machine | `BUS_IDENTITY` strings, no namespace | none — localhost only | SQLite at `~/.claude-bus/bus.db`; Unix-socket wakeup |
| **Distributed** (`src/server/` + `src/plugin/`) | Multiple developers, multiple machines, team inboxes | `user@org/identity` namespaces | Google OIDC (domain-restricted) → server-issued bearer tokens | SQLite on the backend; WSS push to clients |

Both modes expose the same three MCP tools: `bus_send`, `bus_history`, `bus_thread`. The mode is chosen by what your `.mcp.json` points at.

## Common requirements

- [Bun](https://bun.sh) ≥ 1.0
- Claude Code ≥ 2.1.80 (channels feature)
- claude.ai login — the channels feature requires it; console / API-key auth isn't supported

---

## Local mode

Single-machine, no server, no auth. The original v0 architecture, preserved as a first-class mode for solo use.

**How it works.** Each Claude Code session spawns its own grayboard MCP process. Sessions on the same machine share `~/.claude-bus/bus.db` for durability and ping each other via Unix-domain sockets at `~/.claude-bus/sock.<identity>` for live push. No network, no daemon.

### Install

```bash
git clone https://github.com/nolnoch/grayboard.git ~/dev/grayboard
cd ~/dev/grayboard
bun install
```

### Configure each repo

Drop a project-level `.mcp.json` in the repo:

```json
{
  "mcpServers": {
    "grayboard": {
      "command": "bun",
      "args": ["/absolute/path/to/grayboard/src/local/main.ts"],
      "env": { "BUS_IDENTITY": "fe" }
    }
  }
}
```

Use the absolute path. Change `BUS_IDENTITY` per repo (`fe`, `be`, `sim`, etc.).

> Don't put this in user-level `~/.claude.json` — every session would share one identity, defeating identity-based routing.

### Launch

```bash
claude --dangerously-load-development-channels server:grayboard
```

The first time you launch in each repo, Claude Code prompts you to approve the unlisted-channel bypass. Inside the session, `/mcp` should show `grayboard` as `connected`.

### Limitations of local mode

- Localhost only — every process on the box is trusted.
- No accounts, no teams. Identity strings are bare (`fe`, not `wade@.../fe`).
- Both sessions must be on the same machine.

If your use case grows past any of those, switch to distributed mode.

---

## Distributed mode

Centralized backend on a single host, per-session plugin shim on each developer's machine, Google SSO. This is what makes cross-machine and team-based coordination work.

**How it works.** The backend (`src/server/main.ts`) is one EC2 process: terminates WSS, owns SQLite, handles OAuth. Each Claude Code session spawns a thin MCP shim (`src/plugin/main.ts`) that connects WSS to the backend with a session token from `~/.grayboard/credentials`. Same three tools, same `<channel>` notification shape — only the transport is different.

Full architecture in [`docs/architecture.md`](docs/architecture.md).

### Server-side install (one-time, ops)

On a fresh EC2 instance (Ubuntu 24.04 LTS, t4g.small is enough — pick the ARM AMI to keep that instance type available; Bun supports linux-arm64).

```bash
sudo useradd -r -m -d /var/lib/grayboard grayboard
sudo mkdir -p /var/lib/grayboard /etc/grayboard
sudo chown grayboard:grayboard /var/lib/grayboard

# Install the server binary (and the CLI + plugin, which are useful for ops smoke tests)
curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh \
  | sudo INSTALL_SERVER=1 INSTALL_DIR=/usr/local/bin bash
```

Fetch the deploy artifacts (systemd unit, Caddyfile, backup script). Either clone the repo for them, or curl them individually:

```bash
sudo curl -fsSL https://raw.githubusercontent.com/nolnoch/grayboard/master/deploy/grayboard.service -o /etc/systemd/system/grayboard.service
sudo curl -fsSL https://raw.githubusercontent.com/nolnoch/grayboard/master/deploy/Caddyfile         -o /etc/caddy/Caddyfile
sudo curl -fsSL https://raw.githubusercontent.com/nolnoch/grayboard/master/deploy/backup.sh         -o /usr/local/bin/grayboard-backup
sudo chmod +x /usr/local/bin/grayboard-backup
```

Create `/etc/grayboard/env` (mode `0600`, owned by `grayboard`):

```
GRAYBOARD_DB_PATH=/var/lib/grayboard/bus.db
GRAYBOARD_HTTP_PORT=8080
GRAYBOARD_PUBLIC_URL=https://grayboard.example.com
GRAYBOARD_ORG_DOMAIN=example.com
GOOGLE_OAUTH_CLIENT_ID=<from Google Cloud Console>
GOOGLE_OAUTH_CLIENT_SECRET=<from Google Cloud Console>
GRAYBOARD_MESSAGE_RETENTION_DAYS=90
GRAYBOARD_AUDIT_RETENTION_DAYS=90
```

Adjust the hostname in `/etc/caddy/Caddyfile`, then start everything:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now grayboard
sudo systemctl reload caddy

echo "0 3 * * * grayboard S3_BUCKET=<bucket> /usr/local/bin/grayboard-backup" | sudo tee /etc/cron.d/grayboard-backup
```

Caddy handles TLS via Let's Encrypt automatically. WS upgrade is transparent in `reverse_proxy`. Updating the server later is just `INSTALL_SERVER=1 GRAYBOARD_VERSION=v0.2.0 bash install.sh && systemctl restart grayboard`.

<details>
<summary>Alternative: source-tree install (for hacking on the server itself)</summary>

```bash
sudo useradd -r -m -d /var/lib/grayboard grayboard
sudo mkdir -p /opt/grayboard /etc/grayboard /var/lib/grayboard
sudo git clone https://github.com/nolnoch/grayboard.git /opt/grayboard
sudo chown -R grayboard:grayboard /opt/grayboard /var/lib/grayboard
cd /opt/grayboard && sudo -u grayboard bun install
```

Then in `/etc/systemd/system/grayboard.service`, swap the `ExecStart` for the source-mode form (commented in `deploy/grayboard.service`):

```ini
WorkingDirectory=/opt/grayboard
ExecStart=/usr/local/bin/bun run src/server/main.ts
```

Everything else (env file, Caddyfile, backup cron) is identical.
</details>

**Google OAuth setup.** Create an OAuth 2.0 client in Google Cloud Console (Web application). Authorized redirect URIs: not needed for the server-side exchange used here, but the loopback flow uses `http://127.0.0.1:<random-port>/cb` — Google permits loopback redirects without registration. Restrict the consent screen to your workspace if you want extra belt-and-suspenders alongside the `hd` claim check.

### Per-developer setup (one-time)

The recommended path is the install script — no repo clone required, no Bun runtime required to invoke the CLI.

```bash
curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh | bash

grayboard login --server https://grayboard.example.com
```

`install.sh` downloads the platform-appropriate `grayboard` and `grayboard-plugin` binaries from the latest GitHub Release into `~/.local/bin`. Override the destination with `INSTALL_DIR=`, or pin a version with `GRAYBOARD_VERSION=v0.1.0`.

On first invocation, the CLI fetches the Google OAuth `client_id` and the org domain from your backend's public `/api/auth/config` endpoint — there's no per-developer OAuth setup. After login, the server URL is remembered in `~/.grayboard/credentials` so subsequent commands don't need `--server`. (Tip: `export GRAYBOARD_SERVER=https://grayboard.example.com` in your shell profile if you'd rather not type `--server` once.)

`login` opens a browser, completes the Google PKCE flow, and writes `~/.grayboard/credentials` (mode `0600`).

<details>
<summary>Alternative: source-tree install (for hacking on grayboard itself)</summary>

```bash
git clone https://github.com/nolnoch/grayboard.git ~/dev/grayboard
cd ~/dev/grayboard
bun install
bun src/cli/main.ts login
```

The CLI auto-detects whether it's running as a compiled binary (and uses a sibling `grayboard-plugin` binary) or from source (and points `.mcp.json` at `bun src/plugin/main.ts`). Override either with `GRAYBOARD_PLUGIN_PATH`.
</details>

### Per-repo setup

In each repo where you want grayboard tools available:

```bash
cd path/to/your-repo
grayboard identity create fe --mcp
```

That call:
1. Reserves the `fe` identity name under your account on the backend.
2. Writes (or merges into) a `.mcp.json` in the repo. The `command` and `args` are derived from how the CLI itself is installed — compiled binary → points at the sibling `grayboard-plugin`; source tree → points at `bun src/plugin/main.ts`.

You can also write `.mcp.json` by hand. Compiled-binary form:

```json
{
  "mcpServers": {
    "grayboard": {
      "command": "/home/you/.local/bin/grayboard-plugin",
      "args": [],
      "env": { "BUS_IDENTITY": "fe" }
    }
  }
}
```

Source-tree form:

```json
{
  "mcpServers": {
    "grayboard": {
      "command": "bun",
      "args": ["/absolute/path/to/grayboard/src/plugin/main.ts"],
      "env": { "BUS_IDENTITY": "fe" }
    }
  }
}
```

### Launch

```bash
claude --dangerously-load-development-channels server:grayboard
```

Inside the session, `/mcp` should show `grayboard` as `connected`. The plugin reads `~/.grayboard/credentials` at startup, opens WSS to the backend, and exposes the tools.

### CLI reference

```
grayboard login [--dev <email>] [--server <url>]
grayboard logout
grayboard whoami

grayboard identity list
grayboard identity create <name> [--mcp [path]] [--force]
grayboard identity rm <name>

grayboard team list
grayboard team create <name>             # creator is auto-added
grayboard team join <name>
grayboard team leave <name>
grayboard team members <name>

grayboard admin revoke-session --email <e> [--all]
grayboard admin disable-user --email <e>
grayboard admin enable-user --email <e>
```

> v1: any authenticated user can run admin commands. Every admin action writes an audit row.

### Addressing

- Direct: `wade@example.com/fe`
- Team: `team:eng`

Pass either form to `bus_send`. Identity names are 1–32 chars, lowercase, `[a-z0-9_-]`. Team names follow the same rules. Identity uniqueness is per-user; team uniqueness is global.

---

## Tool surface

Same in both modes. From Claude's perspective, only the routing under the hood changes.

| Tool | Purpose |
|---|---|
| `bus_send(recipient, body, parent_id?)` | Post a message to another identity or a team. Returns `{message_id, delivered_now}`. |
| `bus_history(peer?, limit?, before_id?)` | Recent messages you're involved in, optionally filtered by peer. |
| `bus_thread(root_id)` | A root message and every descendant. |

Incoming messages arrive as `<channel>` tags injected by Claude Code:

```
<channel source="grayboard" message_id="123" from="wade@example.com/be" created_at="..." [in_reply_to="..."] [team="eng"]>body</channel>
```

`team="<name>"` is present only when the message was sent to a team. `in_reply_to` is present only when the sender set `parent_id`.

## Delivery semantics

- **Ordering.** Messages to an identity arrive in monotonic `id` order.
- **At-least-once.** Cursors only advance after the client acks the message. A disconnect mid-push causes redelivery on the next connect. `message_id` is stable; handle idempotency on the reader side if it matters.
- **Per-identity team cursors.** Each of your identities advances independently in each team inbox. Joining a team initializes the cursor at the current max — no history replay.
- **Body limit.** 64 KiB UTF-8.

## Limitations and non-goals (distributed mode)

- Single backend instance. A restart causes ~30s of downtime; clients reconnect and re-drain.
- No HA, no multi-AZ, no horizontal scaling.
- No web admin UI — CLI only.
- No per-user rate limits or quotas.
- No defense against intra-company abuse — treated as an acceptable-use matter.
- Sessions never auto-expire. Rotation is by explicit logout or admin revocation.

The migration path to RDS Postgres + ECS is documented in the spec; the repository facade in `src/server/db.ts` is the seam.

## Status

POC. Channels feature in Claude Code is in research preview — the `--dangerously-load-development-channels` flag and the underlying protocol may change. If Anthropic ships a breaking change, small updates to `src/plugin/main.ts` (or `src/local/main.ts` for local mode) should be enough to catch up.

No roadmap, no support commitments. PRs and issues welcome; responses are best-effort.
