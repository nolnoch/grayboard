# Org Slack bridge (not built)

```doc-meta
owns: the design for a Slack bridge in distributed mode
invariants: one bridge per server, inside grayboard-server; human status is server-stamped, never client-asserted; authority is "your own user's human identity", other humans are peers
code-pointers: src/bridge/ (reusable routing and Socket Mode client), src/server/ws.ts (Hub registry, send and call paths), src/server/db.ts (Repo)
companions: ../slack-bridge.md (the local bridge as built)
trigger: a team on a shared server asks to reach its humans from Slack
last-verified: 2026-10-17
```

## Why the local bridge can't run against a server

- Every session of a user presents that user's token, so the server can't tell a human's session from an agent's. `human` would be the client's word, which is exactly what it must not be.
- One Slack app's events go to any one of its Socket Mode connections, so one app can't serve several users' bridges.
- Until this exists, `grayboard bridge slack` refuses server mode.

## Decisions

- **Authority.** On a shared server another user's human can DM your agent; that's a person, not your principal. The server stamps `human="true"` and `human_of="<email>"` on delivery, derived from an `identities.human` flag that only the link flow writes. Clients set neither. The server-mode instruction names the session user's own human identity; only that one carries the user's authority.
- **Placement.** Inside `grayboard-server`, enabled by `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN` in the server env. One Socket Mode connection; if the server ever runs as several processes, exactly one holds it. One workspace per server.
- **Delivery.** Each linked human identity registers in the Hub's connection registry through an adapter, so it is online while the Slack connection is up. Drain, at-least-once and cursor-advance-on-ack apply unchanged; the adapter acks once `chat.postMessage` succeeds. That replaces the local outbox; only the thread map remains.
- **Inbound.** An event from a linked Slack user, in their DM with the bot, acts as that user's human identity through the same paths `ws.ts` uses for `send` and `call`, so `canSend`, board scopes and roster checks apply.
- **Reuse** `relay.ts` routing, `socket.ts`, `web.ts`, text conversion. Not `store.ts`: the thread map is a server table behind `Repo` (the Postgres seam), and server-side bridge code lives under `src/server/`, where the `bun:sqlite` guard applies.
- **Slack surface.** Each user talks to the bot in their own DM instead of a private channel; same threading rules as the local bridge. DMs notify by default. The manifest swaps channel scopes and events for `im` ones and enables the App Home messages tab; verify exact keys against Slack's docs when building.
- **Linking.** `grayboard slack link` gets a one-time code from the server; the user sends `link <code>` to the bot. The server then knows both the grayboard user and the Slack member ID, marks or creates the human identity, stores and audits the link. `grayboard slack unlink` or `unlink` to the bot reverses it. Matching on Slack email (`users:read.email`) would skip the code but trusts that the emails match; a later convenience, not the default.
- **Data sketch.** `identities.human` (0/1); `slack_links (user_id PK, slack_user, dm_channel, identity_id, linked_at)`; `slack_threads (identity_id, thread_ts, kind, board, root_id, peer, last_id)`.

## Open questions

- Can other users' agents reach your phone? `canSend` allows it today. Options: everyone, teammates only, or per-user choice.
- The human identity's name: the email local part, or chosen at link time.
- How Slack-originated mentions interact with team boards the user can see but mostly their agents use.
- Whether the instruction should tell agents their user isn't linked, so they don't DM a human identity nobody reads.
