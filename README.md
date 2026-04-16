# grayboard

A durable message bus that lets two or more Claude Code sessions talk to each other. Built as a custom [channel plugin](https://code.claude.com/docs/en/channels) so messages arrive as push events — no polling, no "Claude has to remember to check."

## What it's for

If you run parallel Claude Code sessions across different repos — say, a Frontend Claude in one, a Backend Claude in another, a Simulator Claude in a third — grayboard gives them a way to coordinate:

- Post a question or status update from one session, delivered to another.
- Queued while the recipient isn't running, replayed when their session starts.
- Threaded replies via `parent_id`.
- History and thread views for catch-up.

It exists because the official `fakechat` demo channel, the reference implementation, is deliberately ephemeral and optimized for a single human-to-Claude chat UI — not Claude-to-Claude coordination that survives either side being offline.

## How it works

Each participating Claude Code session spawns its own `grayboard` plugin — a small [MCP server](https://modelcontextprotocol.io) that speaks [Claude Code's channel protocol](https://code.claude.com/docs/en/channels-reference):

1. **Persistence**: SQLite at `~/.claude-bus/bus.db` stores every message plus per-identity read cursors. Messages survive restarts.
2. **Push, not polling**: each plugin binds a Unix-domain socket at `~/.claude-bus/sock.<identity>`. Sending a message writes the row, then "dings" the recipient's socket. The recipient's plugin wakes up, drains any unread messages from the DB, and emits them as `notifications/claude/channel` events — which Claude Code injects into the live session as `<channel>` tags.
3. **Durable replay on reconnect**: when a session starts, the plugin replays any unread messages addressed to its identity. If A sends to B while B is offline, B sees the message on next launch.
4. **Threading**: `bus_send` takes an optional `parent_id`; `bus_thread` returns a root message and all its descendants.

The plugin exposes three MCP tools to its session:

| Tool | Purpose |
| --- | --- |
| `bus_send(recipient, body, parent_id?)` | Post a message to another identity. |
| `bus_history(peer?, limit?, before_id?)` | Recent messages you're involved in, optionally filtered by peer. |
| `bus_thread(root_id)` | A root message and every descendant. |

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- Claude Code ≥ 2.1.80 (channels feature)
- Linux or macOS (uses Unix-domain sockets)
- claude.ai login — the channels feature requires it; console / API-key auth isn't supported

## Install

```bash
git clone https://github.com/nolnoch/grayboard.git ~/dev/grayboard
cd ~/dev/grayboard
bun install
```

No build step; the plugin runs directly from source.

## Configure each repo that participates

Pick a short, stable identity per repo — e.g. `fe`, `be`, `sim`. In each consuming repo, drop a project-level `.mcp.json` pointing at your grayboard checkout:

```json
{
  "mcpServers": {
    "grayboard": {
      "command": "bun",
      "args": ["/absolute/path/to/grayboard/src/server.ts"],
      "env": { "BUS_IDENTITY": "fe" }
    }
  }
}
```

Use the absolute path to `src/server.ts`, and change `BUS_IDENTITY` per repo.

> **Don't** put this in user-level `~/.claude.json` — every session would share one identity, which defeats identity-based routing and prevents two sessions running concurrently.

## Launch

```bash
claude --dangerously-load-development-channels server:grayboard
```

The first time you launch in each repo, Claude Code prompts you to approve the unlisted-channel bypass — accept it. Inside the session, `/mcp` should show `grayboard` as `connected`.

> `--dangerously-load-development-channels` is required because custom channels aren't on the official allowlist during the channels research preview. The flag bypasses the allowlist for specific entries.

## Using it

In the `fe` session, ask Claude:

> Use the grayboard `bus_send` tool to send "are you done with the auth endpoint?" to `be`.

On the `be` session's next turn, Claude sees:

```
<channel source="grayboard" message_id="1" from="fe" created_at="1776369647813">
are you done with the auth endpoint?
</channel>
```

Claude in `be` replies with `bus_send(recipient="fe", body="yes, merged to main", parent_id=1)`, which lands in `fe`'s session the same way. If `be` isn't running when `fe` sends, `fe` gets `delivered_now: false` and the message queues. `be` sees it on its next launch.

## Delivery semantics

- **At-least-once**: cursors advance after the notification is handed to the transport, so a crash during drain can cause a message to be re-delivered. `message_id` is monotonic across the whole bus; handle idempotency on the reader side if that ever matters.
- **Ordered per-recipient**: messages arrive in insertion order for a given recipient.
- **Durable**: messages persist in SQLite until you delete the DB.

## Data and state

| Path | Purpose |
| --- | --- |
| `~/.claude-bus/bus.db` | SQLite store (messages, cursors). WAL mode. |
| `~/.claude-bus/sock.<identity>` | Unix socket used as the wakeup doorbell. |

Both are safe to delete between runs; sockets rebind on the next launch. Override with `BUS_DB_PATH` and `BUS_SOCK_DIR` environment variables if you want them somewhere else.

## Limitations and non-goals

This is a single-machine personal tool, not an enterprise messaging product. It deliberately **does not**:

- Authenticate senders (localhost-only; every process on the box is trusted).
- Relay permission prompts (see the channels reference for `claude/channel/permission` if you want remote approve/deny).
- Support multiple machines (sockets are local; replace with TCP + auth if you need it).
- Handle rooms / broadcasts (send twice if you want fan-out of two).
- Rotate or compact the DB (grows forever; negligible at human scale).
- Ship as a packaged Claude Code plugin (runs bare via `.mcp.json`).

If your use case needs any of those, this is a fine starting point but you'll be doing more work.

## Status

grayboard depends on Claude Code's channels feature, which is in research preview — the `--dangerously-load-development-channels` flag syntax and the underlying protocol may change. If Anthropic ships a breaking change, small updates to `src/server.ts` should be enough to catch up.

No roadmap, no support commitments. PRs and issues welcome; responses are best-effort.
