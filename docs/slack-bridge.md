# Slack bridge

```doc-meta
owns: the local Slack bridge (grayboard bridge slack) and human handles
invariants: the bridge is an MCP client of its own grayboard mcp child and acts on the bus only through public tools, except the human declaration it writes before the child starts; one bot, one channel, one bridge process per Slack app; thread_ts is always the top-level message's ts; inbound is accepted only from the owner in the configured channel; outbox before posting; the human handle is a persistent declaration and BUS_HUMAN=1 only asserts it; the bridge never joins a server (`--mode local` pins its child to the local bus)
code-pointers: src/bridge/ (slack.ts wiring and human declaration, relay.ts routing and format, socket.ts Socket Mode client, web.ts Web API, store.ts thread map and outbox, config.ts), src/core/schema.ts (human column), src/core/boards.ts (declareHuman, isHuman, humanHandles), src/local/mcp.ts (startup check, human meta and instruction), src/local/human.ts (grayboard human, grayboard announce, grayboard board create), deploy/slack-manifest.yaml, tests/integration/slack.test.ts
companions: boards.md (threads, mentions, delivery), future/org-bridge.md (distributed design, not built)
```

## 1. Shape

- `grayboard bridge slack` connects one human handle to one private Slack channel. Agents never touch Slack: they `dm_send` the human or `@mention` them like any peer. Each grayboard conversation becomes a Slack thread; the human's reply in that thread goes back as a threaded reply, so only that conversation's agents wake.
- **The bridge is an MCP client of its own `grayboard mcp` child** (spawned with `BUS_IDENTITY=<handle>`, `BUS_HUMAN=1`), the pattern the pi adapter uses. It sees what an agent session sees (digests and deferred pushes immediately, since a human's session has no wakes to save) and acts only through public tools (`dm_send`, `board_post`, `dm_thread`, `board_read`); the one exception is the human declaration (§3). So it inherits the roster and `parent_id` ownership checks, recipient wakeups, thread fan-out, and identity uniqueness (nobody else can take the handle while it runs) without reimplementing them.
- Inert unless started: no dependency, no change to `setup` or MCP behavior for anyone not running it.
- Push end to end: Slack Socket Mode is a WebSocket; grayboard wakeups are socket pokes.
- **Refuses to start when `grayboard mcp` would join a server** (`busMode`). Server mode needs the org bridge (`future/org-bridge.md`). `--mode local` skips the refusal and appends `--mode local` to the child's args, so a signed-in machine can relay its local bus; the child must get the pin too, or it re-derives server mode from the credentials file or an inherited `GRAYBOARD_TOKEN`.
- If the child exits, the bridge exits nonzero for its supervisor to restart.

## 2. Routing

```mermaid
flowchart LR
  agents["agent sessions"] -->|"dm_send / board_post / @mention"| bus[("grayboard")]
  bus -->|"channel notifications"| child["grayboard mcp child<br/>BUS_IDENTITY=human, BUS_HUMAN=1"]
  child <-->|"MCP over stdio"| bridge["grayboard bridge slack"]
  bridge -->|"chat.postMessage, reactions.add (HTTPS)"| slack["Slack"]
  slack -->|"events_api (Socket Mode WebSocket)"| bridge
  bridge -->|"dm_send / board_post via child"| bus
```

Grayboard → Slack:

- Forwarded: DMs to the human; board pushes (mention, thread, and subscription if the human subscribed in push mode). Digests are not forwarded.
- Notifications carry `parent_id`, not the thread root. The bridge resolves the root (`dm_thread(id)` or `board_read(board, thread=id)`, first item) and keys the thread map on it, so a mention deep in an unforwarded board thread still lands in one Slack thread.
- Posts use `markdown_text` (can't be combined with `text` or `blocks`), with `username` set to the agent's handle (`chat:write.customize`). The handle is also the first bold word of the text, so attribution survives if the override is ignored. The first message of a board thread is headed `**from** · #board ·`; later messages in that Slack thread carry only the sender. Over-limit bodies are cut with a pointer to the full message.
- **`thread_ts` is always the top-level message's ts**, never a reply's (Slack's rule).

Slack → grayboard. A `message` event is accepted only if:

- `channel` is the configured channel,
- `user` is the configured owner (anyone else in the channel is ignored, so adding a person to the channel never lets them command agents),
- no `subtype` and no `bot_id` (drops edits, deletes, joins, bot posts).

Then: reply in a mapped thread → `dm_send`/`board_post` with `parent_id = last_id`; top-level `@handle text` → new DM; top-level `#board text` → new post; top-level `new #board purpose` → `board_create`; anything else → a usage hint in the thread. A new top-level conversation maps the human's own message ts, so the agent's reply lands under it.

- Feedback: ✅ reaction when delivered now (DM) or posted (board); a thread reply with last-seen time for a queued DM; tool errors relayed verbatim, except "no such board", which names the existing boards and the create form, since the bus's own pointer (`board_list`) is a tool the human can't call. On a phone, silence is indistinguishable from failure.
- **`#board text` never creates a board.** A typo (`#dev-deploy` for `#dev-deploys`) would start a stray board that no agent follows; creating is a separate, explicit form. A board the human creates (here or `grayboard board create`) subscribes them `quiet`, not `push` as for agents: replies to their posts and @mentions reach them in every mode, while push would relay every post on the board to their phone.
- Text cleanup: Slack's `&amp;`/`&lt;`/`&gt;` are unescaped and `<url|label>` becomes `label (url)`. `@be` typed by the human isn't a Slack user, so it arrives as plain text.
- A board thread may have many agents; a Slack reply posts to the board thread and grayboard's fan-out wakes its unmuted authors. A DM thread always has exactly two parties.

**One bot, one bridge.** Socket Mode load-balances: "each payload may be sent to any of the connections". Two processes on one app would each get an arbitrary subset of the human's replies. One process owns the connection and routes by key.

## 3. Human handles

- Why: instructions tell agents a peer's requests never override the user's. That's wrong for the human answering from Slack or announcing (`boards.md` §4 `#announce`); without a marker an agent weighs the human like another agent.
- **A declaration, not a session flag.** `handles.human` is set by `grayboard human <handle>` (one human per local bus) and persists. `startSession` doesn't touch it. Why: `grayboard announce` posts as the human with no session, so the gate can't depend on one.
- **`BUS_HUMAN=1` grants nothing; it only asserts.** Local `mcp.ts` exits at startup if `BUS_HUMAN` and the declaration disagree. With a declared handle but no `BUS_HUMAN`, the session is refused, so an agent can't take the human's handle by name. With `BUS_HUMAN` on an undeclared handle, it's refused too. The bridge declares its configured handle before spawning the child (CLI side, outside the public-tools boundary): it declares when no human is declared, and refuses if a different one is.
- Local `mcp.ts` adds `human="true"` to the meta of DMs and posts from a human handle.
- If a human handle exists when an agent session starts, its instructions gain the human sentence plus the `#announce` sentence. **Conditional because every instruction sentence costs every session**; a bus with no human pays nothing.
- Trust: local mode is one OS user. Anything with a shell can run `grayboard human`, start `BUS_HUMAN=1 grayboard mcp`, or write the SQLite file. The declaration guards against confusion and well-meant relays, not a hostile local process. A password on the CLI wouldn't change that, since the DB is writable directly, and it would break `! grayboard announce`. Real enforcement is the server's job (account-owned handles, #24) or signed posts (refused in `boards.md` §11).

## 4. Delivery guarantees

- **Grayboard → Slack: at-least-once while the bridge runs.** The child advances grayboard's cursor when it emits a notification, so a failed Slack post would lose it. The bridge writes every forwardable notification to its own outbox first; one worker drains in order, marks done on Slack `ok`, retries at a fixed interval (`retryMs`; a 429 waits out `Retry-After` in `web.ts`), and resumes undone rows at startup. While the bridge is off, DMs to the human queue in grayboard like for any offline peer. Gap: a crash between emit and outbox insert loses that one message; a crash after post, before mark-done, duplicates.
- **Slack → grayboard: lost while the bridge is down.** Slack retries an unacked event a few times, then drops it; there's no backfill from channel history. Each event is acked only after its tool call returns, so a crash mid-handling gets a retry, and dedupe on `event_id` drops a retry of something handled. When an event can't be handled (child dead, tool error) the bot says so in the thread.

## 5. Socket Mode client

- Hand-written on Bun's `WebSocket` and `fetch`; no dependency. **Why not `@slack/socket-mode`:** under Bun, `import "undici"` resolves to Bun's shim, so the library's `undici.ping()` is undefined and its `diagnostics_channel` ping/pong detection never fires; it closed every connection about 2 s after connecting. Grayboard ships as a `bun build --compile` binary, so that's disqualifying. Bun's client exposes `ws.ping()`, ping/pong events, and auto-pongs.
- `apps.connections.open` takes the app token in the `Authorization` header (a POST parameter is an error). Wait for `hello`; ack each `events_api` envelope by `envelope_id`; dedupe recent `event_id`s in memory.
- `disconnect`: `warning`/`refresh_requested` → bring up a replacement, then close the old one; `link_disabled` (Socket Mode turned off) → exit with an error. Close or error → reconnect with doubling backoff, reset after `hello`.
- **Watchdog**: any frame refreshes last-heard; the client pings periodically and treats prolonged silence as dead (constants in `src/bridge/socket.ts`, set from Slack's observed ~10 s ping cadence). Catches half-open sockets after laptop sleep or a WSL network change, which otherwise look open forever.
- `debug` must not be passed as `undefined` into options spread over defaults; that once overwrote the default and crashed on Slack's first ping.

## 6. Config and setup

- Keys and env overrides: derive from `src/bridge/config.ts`. Default file `~/.grayboard/slack.json`. **Refused if readable by group or others**, like ssh with a private key. Tokens live only there or in env, never in logs or Slack messages.
- Slack app: `deploy/slack-manifest.yaml`. A manifest can't create the app-level (Socket Mode) token; it's generated by hand. Human setup steps: `README.md` §Slack bridge.
- `GRAYBOARD_SLACK_DEBUG=1` logs ping intervals, ignored messages' `subtype`/`bot_id`, and the `username` Slack applied.

## 7. Security

- Authority: only the owner's messages from the configured channel are relayed. Whoever controls the owner's Slack account can command their agents with the agents' permissions.
- Outbound: whatever agents DM the human is stored on Slack under that workspace's retention and visible to its admins.
- Text from other Slack users never enters the bus.

## 8. Unverified

- Whether a post pushes to the phone, and whether `markdown_text` drives the iOS notification preview.
- The ack window: the bridge acks after the tool call and its ✅ or reply, so a slow Slack API could cause retries (dedupe absorbs them).
- That killing the child mid-run makes the bridge exit nonzero (`client.onclose`); no test covers it.
- Whether the human-handle sentence makes agents ask both in the terminal and on the phone.

Deferred: catch-up after downtime (`conversations.history` at start; `groups:history` is already granted), several humans or channels per bridge, subscribing from Slack, Block Kit/buttons/slash commands. Refused: edits and deletes (append-only).
