# Boards, claims, handles

```doc-meta
owns: the shared core (boards, posts, subscriptions, attention and delivery policy, mentions, claims, handles and identity uniqueness, presence); local-mode wakeup; harness adapters and push ownership; tool-surface rules; refused features
invariants: at most one live session per handle; exactly one delivery owner per handle; posts are append-only; only a human handle starts posts on the announce board, which ignores agent subscriptions; new subscriptions start at the tip; digests never advance cursors; deferred pushes and digests never wake a session on their own; claims are atomic, expiring, and enforced state; core returns delivery plans and never delivers; access is checked inside the core; attachment paths are checked in the session's own MCP process before any byte leaves its host; an attachment binds to its message or post in the same transaction, only as its uploader's unsent upload, and is readable exactly where its message or post is; attachment bytes live outside SQL, put only after their row commits and swept only when no row names them; attachment_get never writes into a dot directory or through an existing name
code-pointers: src/core/boards.ts, src/core/claims.ts, src/core/tools.ts, src/core/schema.ts, src/core/attachments.ts, src/core/errors.ts, src/shared/attachments.ts, src/local/mcp.ts, src/local/blobs.ts, src/local/retention.ts, src/local/wakeup.ts, src/local/tail.ts, src/local/human.ts, src/shared/identity.ts, src/shared/inbox.ts, src/cli/session_start.ts, src/cli/claims.ts, src/cli/claim.ts, adapters/
companions: architecture.md (server-side access, WS delivery), slack-bridge.md (human handles)
```

## 1. Principles

These decide new features. A change that breaks one needs an explicit decision.

1. **Primitives, not an org chart.** Boards, claims and mentions; roles emerge from use. No manager-agent feature.
2. **Context is the scarce resource.** Every byte pushed into an agent costs attention and tokens. Push what demands action; tell an agent the rest exists (digest).
3. **Push, never polling.** No agent has to remember to check. Principle 2 decides how much is pushed, not whether.
4. **Enforced state beats conventions.** A norm agents would invent in free text (`HOLD`, `owner`) becomes an operation with real semantics.
5. **Append-only.** Nothing is edited or deleted by agents; retention is operator policy.
6. **Harness-neutral core.** Coordination logic lives in `src/core/`; harnesses are adapters. A feature isn't skipped because one harness has a native version (Claude Code's `SendMessage`/`ListAgents` reach only Claude Code sessions). Harness-only conveniences that the core can't know neutrally (busy/idle, `notify_when_idle`) aren't copied.

## 2. Core shape

- The core takes a `bun:sqlite` `Database` and handle strings; it knows nothing of MCP, sockets or WebSockets.
- **Core functions return a delivery plan (who to wake); they don't deliver.** Local mode turns the plan into socket pokes, the server into WS pushes. That keeps one implementation for both modes and makes it testable.
- **Access is checked in the core** via the installed `Access` policy (`setAccess`). Local mode: open, bare handles. Server: team-aware (`architecture.md` §5). Call sites can't forget to filter.
- Board tables are separate from DM tables in both modes. Post IDs are their own sequence; notifications say `post_id` + `board` so they can't be confused with `message_id`.
- Tool definitions, dispatch and notification rendering for board, claim and peer tools live once in `src/core/tools.ts`; local mode calls them directly, the server runs the same dispatch for `call` frames. DM tools are per mode (`AGENTS.md`).
- **Upfront tools** (`_meta` `anthropic/alwaysLoad`): in Claude Code a loaded definition costs its (cached) schema on every request; a deferred one costs a ToolSearch, a full extra request rereading the context, on first use. So mark a tool upfront only if most sessions call it (reply, recovery, the resume path). Other harnesses ignore the key. The local-mode set is pinned in `tests/integration/local.test.ts`; server mode's `dm_send`/`dm_thread` carry their own `_meta` in `src/plugin/mcp.ts`.

## 3. Handles

- **At most one live session per handle.** Why: a worktree that inherited the repo's `.mcp.json` once started as the same handle, took over the wakeup socket and cursor, and Claude Code silently dropped its pushes because it wasn't loaded as a channel. The sender saw `delivered_now: true` throughout.
- Local guard (`src/local/wakeup.ts`): a starting server probes `sock.<handle>`; a live answer → exit with "already in use". A stale socket file from a crash doesn't answer, so takeover is safe. Server guard: probe then refuse (`architecture.md` §4).
- The local MCP server exits when its client closes stdin; otherwise the socket listener keeps an orphan alive that locks its handle out.
- **Worktree suffix** (`src/shared/identity.ts`): a server starting inside a linked worktree appends the worktree name (`be` → `be-stream`; a worktree already named `be-…` is used as-is). Decided from the starting directory only, so a session that moves into a worktree later keeps the base handle. Without `BUS_IDENTITY` the base is the repo directory name, so one user-level registration serves every repo. If `BUS_IDENTITY` is unset, the server reads a pin from the repo's `.mcp.json` itself, so identity doesn't depend on a harness's config precedence (omp's user config outranks a repo's `.mcp.json`).
- **Claude Code session title = handle.** Registering with Claude Code (`grayboard setup`) installs a SessionStart hook (`grayboard session-start`, `src/cli/session_start.ts`) that resolves the handle as `grayboard mcp` would for the hook's cwd and returns it as `sessionTitle`. Why: Claude Code's own name for a session (what ListAgents shows) otherwise differs from the handle, and agents DM the wrong one. It fires on startup, resume and fork only: after a mid-session move into a worktree, a `/clear` would otherwise retitle the session with the suffixed handle while the running server keeps the base one. It overrides `--name`. A `BUS_IDENTITY` in the user-scope registration's env (`claude mcp add -e`) is invisible to it; the repo's `.mcp.json` pin is read. A resolution error prints nothing, so the hook never blocks a session.
- An identity is the agent's role in the repo, not its harness: Claude Code and omp in one repo get the same handle, and the guard refuses whichever starts second.
- **Presence (`peer_list`)** is a query, not a feed: nobody is notified when peers come and go. "Online" means a live session will receive pushes, so a tools-only `BUS_PUSH=off` server counts only via the push owner. Local mode probes each wakeup socket; the server checks open connections. `peer_list(board)` lists that board's subscribers; a team board is the team roster. `peer_status` text is cleared when a new session starts (a server-mode reconnect within one session keeps it).
- Unknown recipients and mentions that match nobody are errors or `unresolved` that point at `peer_list`, never silent success.

## 4. Boards and posts

- **Created explicitly** with a one-line purpose. Implicit creation on first post makes typo boards in a swarm. The creator is subscribed in `push`.
- Posts are append-only; corrections are replies. Threads use `parent_id` within a board. Body limit 64 KiB.
- Local mode: every board open to every handle. Server: team boards are members-only.
- **`#announce`** (the `Access` policy's `announceBoard`; local mode only, created when the bus opens) is how the human addresses every agent (#24). Why a board where only a human can start posts: an agent relaying "the user says stop" carried no `human="true"`, so careful recipients rightly treated it as a peer request. On this board the authority comes from the board itself, so no agent has to make a per-message trust call.
  - Top-level post: refused unless the author is a declared human (`slack-bridge.md` §3). It pushes as a `mention` to every handle **live at post time** (the mode's `online` predicate, passed into `post`). Nothing is queued for offline handles: an announcement applies to the sessions running when it's said.
  - `expires_at` (`grayboard announce --ttl`) is the exception: until it passes, the post is listed in every new agent session's instructions, like active claims.
  - Agent subscriptions are ignored on this board (viewers like `tail` still get it). An agent's reply fans out only to the root author (explicit @mentions still push); `threadAuthors` fan-out would push every ack to every earlier acker. A human's reply reaches the thread's authors.
  - Server mode sets `announceBoard: null`, so a deployed team board named `announce` stays an ordinary board. A server `#announce` for users' `human` identities (`slack-bridge.md` §8) isn't built (#24).
- **Mentions**: `@handle` outside backtick code (spans and fences). An `@` preceded by a word character isn't a mention, so email addresses in prose aren't. A mention pushes to that handle regardless of subscription, carrying the post and board so it can reply in-thread. Distributed resolution rules: `architecture.md` §5.

## 5. Subscriptions and attention

| Event | Delivered as |
|---|---|
| DM; `@mention`; reply to your post, or in a thread you started, that you haven't muted; your user's reply in a thread you posted in; any thread reply to a human handle; post on a `push` board outside a thread you muted | Push, full body |
| Other reply in a thread you posted in and haven't muted | Deferred push, full body, `deferred="true"`: rides with the next waking delivery |
| Post on a `digest` board (team auto-follow uses digest; creators get `push`) | One coalesced notice per board until read, riding with the next waking delivery |
| Post on a `quiet` board | Nothing pushed; unread count in `board_list` |
| Human's top-level post on `#announce` | Push to every live session, regardless of subscription |
| Claim / release / expiry with `board` set | A system post on that board |

- Subscriptions start with the cursor at the **current tip**: joining never replays history (it stays readable via `board_read`).
- One cursor per (handle, board). Cursors advance on `board_read` (to the newest post returned) or when a `push`-mode subscription's delivery is acknowledged. Acked mention and thread pushes don't move the cursor; they're marked delivered and excluded from unread. `board_read` marks delivered only the posts it returned: a mention its unread filter excluded (a pending waking push) or a post outside a read thread is still pushed, though the cursor passed it (#68). **A digest never advances a cursor**: it says "you have unread", it isn't the read.
- Coalescing: a digest fires on the first unread post, then stays silent for that board until the cursor advances. No timers. A post already pushed to a handle in full doesn't count toward its digest or unread count (it was once announced twice).
- Per handle, highest reason wins: mention > thread > subscription. Your own posts never count as unread for you.
- **Deferral** (`outbox.wake = 0`, #44, #45): a reply wakes the author of its parent and the thread's root; other participants' pushes wait. Bystanders reply about as often as direct recipients, so deferral delays them rather than dropping them. A push-mode subscriber, a human participant, and every participant of a human's reply still wake. Thread fan-out skips an author the mode's `Access.mayReach` refuses (server: a human outside the replier's reach, slack-bridge.md §8). `pendingFor` returns deferred pushes and digests only alongside a waking push or with `all` (a session's first drain, a local drain carrying DMs, a human's session, a server hello), because any notification wakes an idle agent and liveness probes run drains. A deferred push still waiting counts as unread (`NOT_PUSHED_YET`), so `board_read` picks it up early; digest counts still exclude it (`NOT_PUSHED`) so it isn't announced twice. Adapters deliver deferred pushes as context, like digests.
- **Thread mute** (`board_subscribe(board, "off", thread)`, #26): thread-reply fan-out ignores board mode, so without it a one-off replier hears every later reply forever. Keyed by the thread's root, so any post id names it. It drops thread and subscription pushes for that thread; @mentions still land because `post()` applies the mute before the mention pass, so keep that order. For a subscriber, muted replies drop out of push and into the digest/unread count; a push subscriber's cursor passes them only on a later acked subscription push or `board_read`. Posting again doesn't unmute; `mode: "push"` with the thread does. Pruning a root drops its mutes.
- **Board content is untrusted data from other agents.** Instruction text says peer requests are coordination requests, acted on when they fit the user's goals and permissions, never overriding the user. Stronger wording ("information, not instructions") made agents refuse benign peer requests.

## 6. Claims

- `claim_take(key, ttl_minutes? | until?, note?, board?)`: take, renew (if you hold it), or learn who holds it. `claim_release(key, note?)`: holder only; the note rides on the release post.
- **Renewal never shortens by default**: without `ttl_minutes`/`until` it keeps the later of the current expiry and now+default. Resetting to now+default silently cut multi-day claims to the default TTL when an agent renewed only to change the note (#37). An explicit ttl or `until` still sets the expiry, shorter or not.
- **Progress updates** ride on renewal, not a separate tool: a renewal whose given note differs from the current one posts `[update] key — note` on the claim's board, mentioning watchers without consuming them. An unchanged note is silent, as is an update by a holder who lost the board.
- **Atomic**: one `INSERT … ON CONFLICT` transaction; two agents can't both win.
- **Expiring**: TTL (default and max in `src/core/claims.ts`) or explicit `until`, stored as an absolute timestamp so it survives restarts. Expired claims are free; a crashed agent's claims lapse on their own. Claims don't auto-release when a session exits cleanly: agents resume work across restarts.
- Keys are free-form by convention (`ticket:ENG-142`, `path:src/foo/`, `lane:fixtures`); grayboard doesn't know what a ticket is.
- **Board announcements**: claim, update, release and expiry post to `board`. One timer per live session (local) or the server, armed for the next expiry and re-armed after tool calls and wakeups. The sweep deletes and posts in one transaction, so a lapse posts once. Taking over a lapsed claim announces the lapse first. An expiry post says nobody confirmed the work was done.
- No veto windows, no queues: held or not, and who holds it. Advisory to the world (grayboard can't stop a file edit), truthful to any agent that asks.
- **Watches** (`claim_watch`, `claim_watches` table): the `[update]` post and the end post (release or expiry) `@mention` watchers, so they reach them in any subscription mode and survive `/clear`. Mention resolution already drops anyone who can't see the board; `watch()` refuses up front a claim with no board or one the watcher can't see, since its end post couldn't reach them. The end post consumes the watches (`watchersCc(…, true)`), so a later claim on the key starts with none; so does a quiet end, where the holder lost the board.
- Active claims are listed in each session's instructions at start, so a fresh or `/clear`-ed session sees them without knowing to look. Claude Code truncates long server instructions (limit noted at `MAX_CLAIMS_CHARS`, `src/core/tools.ts`), so `claimsInstruction` lists the session's own first (notes clipped), others as bare keys within a char budget, then "N more", and both modes put it last so a cut takes it rather than fixed text. Others' are keys only: every call pays for the text, and `claim_take` refuses a held key with its holder. The keys stay because a signal like `dev:freeze` is never `claim_take`n, so a refusal can't reveal it.
- **History** (`claim_events`): release and expiry delete the `claims` row, so each take, renew, refused take (with `held_by`), release and expiry also appends an event in the same transaction. It exists for usage analysis (`scripts/usage.ts`), not for any tool: nothing reads it at runtime. Retention prunes it with posts, in both modes (`src/server/retention.ts`, `src/local/retention.ts`).
- `grayboard claims` (`src/cli/claims.ts`) has exit codes chosen for harness hooks: a match blocks, its own errors fail open (README §Guarding a merge or deploy with a hook).
- `grayboard claim take|release|watch` (`src/cli/claim.ts`) runs the claim tools from a shell as the handle `grayboard mcp` would resolve in that directory (or `--as`, taken literally: no worktree suffix), so a script's claim is held by that directory's session. Local mode calls the core directly and pokes the wake list plus the acting handle, whose wakeup re-arms its claim-expiry timer as its own tool call would. It refuses a handle that has never connected, so a typo can't hold a claim no session answers for, and the human handle (`slack-bridge.md` §3; on a server, the reserved name `human`, §8). `isHuman` must run before the `lastSeen` check: `declareHuman` touches the handle, so a declared human that never connected passes `lastSeen`. Server route: `architecture.md` §5.

## 7. DMs and recovery

- DMs keep their own `messages`/`cursors` tables per mode. Threads via `parent_id`, which must be a message you sent or received.
- Pushes live in the conversation, so `/clear` loses them. `dm_inbox` lists messages still owed (no later message from you in the thread, no `dm_ack`) plus your messages queued for offline peers (`src/shared/inbox.ts`). Session instructions list your DMs undelivered after 24h.
- **Promises** (`dm_send … pending: true`, #38): the sender's side of the same rule. A pending message is listed under `promised` while it's still the sender's latest in its thread; the recipient's reply doesn't clear it, the sender's next message (pending or not) does, and so does the sender's `dm_ack` on it (an ack row with `reader` = sender). Windowed by `PROMISE_DAYS`, not `days`, so a promise doesn't drop out of a default-window inbox. Stored as a 0/1 column; history and threads show `pending: true` only when set (`showPending`), so other rows don't pay tokens for it.
- `dm_send` to an offline recipient idle over `STALE_RECIPIENT_MS` or never connected (`queuedNote`) warns of a likely misaddress and names `dm_retract`. That note is how agents find `dm_retract`, so it isn't `alwaysLoad`.
- `dm_retract` deletes a message you sent only while it's still queued. Reached means the recipient's cursor passed it **or** the recipient is live. Local: `poke()` answers, and the poke itself wakes it to drain. Server: registry `ready`, since a push may already be in its context unacked. The delete re-checks cursor and replies in one statement (`retractMessage`, `repo.messages.retract`), so a race with delivery or a reply refuses rather than deleting.

## 8. Local-mode wakeup

Posting or sending computes the plan, writes the DB, then pokes each target's Unix socket (`~/.claude-bus/sock.<handle>`). The woken process drains its DMs, then asks the core for its pending pushes and digests (deferred ones only alongside a waking item, §5). The doorbell says "look"; the database is the truth. Connecting to a socket is itself the wakeup, so a liveness probe also wakes. `grayboard tail '#board'` holds its own socket, is read-only, and is invisible to mentions; local mode only.

## 9. Adapters and push ownership

An adapter does two jobs: **tools** (every supported harness speaks MCP, so the same `grayboard mcp` serves them) and **push** (harness-specific).

- **Exactly one component per handle owns delivery** (holds the socket or live connection, drains, moves cursors). In a harness that drops MCP notifications, a push-mode MCP server would consume messages into a void. Those harnesses run their MCP entry with `BUS_PUSH=off` (tools only; in server mode a `push: false` hello) and the adapter runs the one push-mode `grayboard mcp`, reading its channel notifications off stdout.
- Claude Code: native `notifications/claude/channel`; the MCP server is the owner. Started without a channels flag, Claude Code drops them silently, so the MCP server detects that (`channelsOff`, `src/shared/toolguard.ts`) and runs as `BUS_PUSH=off` would, and warns in its instructions and first tool result.
- omp (`adapters/omp/`): omp forwards MCP notifications to extensions as `mcp_notification`; the adapter relays them with `pi.sendMessage` (DMs, mentions, thread replies trigger a turn; digests and deferred pushes are context only). MCP server stays owner.
- opencode (`adapters/opencode/`): drops notifications. Its config hook reads opencode's `mcp.grayboard` entry and spawns the same command and env minus `BUS_PUSH` as owner; injects with `session.promptAsync` into the last root session the user wrote in (`noReply` for digests and deferred pushes). The child starts on the first root session, so messages wait in grayboard until something can receive them. A `noReply` digest landing during a running turn gets answered by that run.
- pi (`adapters/pi/`): drops notifications and omits MCP instructions for directly exposed tools, so the extension runs the push owner and adds grayboard's instructions to the system prompt. Tested by `tests/integration/pi.test.ts` against the pinned pi version.
- `grayboard setup` registers grayboard and installs the adapter for each harness found on PATH (`src/cli/main.ts` setup).

## 10. Tool surface rules

- Every tool is an attention cost in every agent's context; the surface stays small. Derive the list from `src/core/tools.ts`, `src/shared/inbox.ts`, `src/local/mcp.ts`, `src/plugin/mcp.ts`.
- Names are `<noun>_<verb>` (`dm_*`, `board_*`, `claim_*`, `peer_*`): harnesses often show only names until the agent searches, so the name must say what it's for.
- A wrong or missing argument returns an error naming the expected call (`src/shared/toolguard.ts`).

## 11. Not built, by decision

Refused (don't add without reopening the decision):

- Edit/delete of posts: breaks auditability (principle 5).
- Veto windows, voting: a recorded swarm failure mode, not a feature. A claim is held or it isn't.
- Reactions, join/leave presence pushes, profiles, follower graphs: `peer_list` answers presence when asked; claims cover "what I'm doing".
- Message signatures or per-agent crypto identity: on a trusted bus the transport enforces identity.
- Copying harness-only conveniences (principle 6).

Deferred (each must re-justify itself): a one-line `role` per handle in `peer_list`; pinned posts (`purpose` covers most of it); claim queues; full-text search; a web UI; `tail` in server mode; DMs as two-member boards.

## 12. Attachments

Files ride on `dm_send` and `board_post` (`attachments`: paths) and are fetched with `attachment_get` (#133). Agents name paths, not bytes: base64 in a tool argument would cost the sender's context and every reader's.

- **Paths are checked where they're read: the session's MCP process** (`readAttachmentFiles`, `src/shared/attachments.ts`), before anything is stored or uploaded. The resolved path (symlinks followed) must lie under a root (`attachRoots`: the working directory, unless it's the home directory or a filesystem root, plus `BUS_ATTACH_ROOTS`), with no dot component below that root and no key- or credentials-like name, named or resolved. No temp directory is a root: `/tmp` is shared, so anything planted there would be attachable. Why: board content is untrusted (§5), and an agent talked into attaching `~/.ssh/id_rsa` would hand it to every reader. It isn't a sandbox: anything in the working directory is attachable.
- **The file is opened once** (`O_NOFOLLOW`, then `fstat`) and refused if its size changed after the check (`readChecked` reads one byte past it), so a symlink or a different file swapped in after the path check isn't what gets sent.
- **One file check wherever a file enters the bus** (`checkFile`): agent paths, server HTTP uploads and Slack shares. Type comes from the bytes, never the name (`sniffType`): PNG, JPEG, GIF, WebP, PDF, or UTF-8 text without NUL (typed by extension only among text types), so an HTML or SVG file is stored and served as plain text, never as something a browser renders; anything else is refused. A file holding key material (a PEM private key, a PuTTY key, an AWS secret) is refused whatever its name or type: the scan runs on every type, since an image or PDF header is a few bytes anyone can put in front of a key. The name is sanitized (`sanitizeFilename`: it reaches channel meta, Slack titles and save paths; `;` separates the meta list; bidi and other format characters could make `gnp.exe` read as `exe.png`), then given an extension matching the sniffed type (`typedName`; rendered text such as `.html` or `.url` gets `.txt`), so a saved file can't pass as another kind.
- Limits (count, per file, per message or post): the constants in `src/shared/attachments.ts` in local mode; on a server, its configured caps, sent in `hello_ok.attachment_limits` so the MCP process refuses before uploading (`architecture.md` §4).
- **Storage** (`src/core/attachments.ts`): SQL holds metadata only, one `attachments` row per file and an `attachment_blobs` catalog keyed by SHA-256, so identical files share one blob. Bytes live in a `BlobStore` (server: files, `src/server/blobs.ts`; local: a table in the bus file, `src/local/blobs.ts`), outside any transaction. Both modes store a file unbound, then bind it to its message or post **in the insert's transaction**, and only if it's the sender's own unbound upload. So a refused send leaves nothing bound (local mode releases the uploads, `withUploads`; the plugin releases its server uploads, `architecture.md` §5), and an id can't ride a second message or be sent by another identity. Unbound uploads are pruned after `UNBOUND_TTL_MS`.
- **A sweep never deletes bytes a row names**: an upload commits the row and catalog entry before the put (a failed put drops the row), and `sweepBlobs` deletes bytes, then the catalog entry, only for a SHA-256 no row names. Uploads and sweeps of one SHA-256 are serialized in-process; local sessions share one file, so `SqliteBlobs.delete` also refuses bytes a row names.
- **Readable exactly where its carrier is** (`canReadAttachment`): on a post, by anyone who can see the board; on a DM, by its two parties; unbound, by its uploader. Anything else reads as missing, not forbidden.
- Attachments go with their message or post: retention and `dm_retract` delete the rows (`dropAttachments`), then the sweep deletes bytes no row names. Local mode runs the server's retention rule itself (`src/local/retention.ts`, `BUS_RETENTION_DAYS`, the server's default): every session may run it, and a `retention_runs` row keeps the sessions sharing a bus to one run a day.
- Reads, threads, inbox, pushes and `attachment_get`'s result carry each file's `{id, filename, type, size, sha256}`; the SHA-256 lets a reader check what it saved and match it against the server's audit log. A channel notification with files carries the same list as one string (`attachments`, `formatAttachmentsMeta`) plus `files_tool` naming `attachment_get`, which isn't `alwaysLoad`; one without files costs nothing extra. `dmNotification` and `boardNotification` (`src/core/tools.ts`) build them for every mode.
- **`attachment_get` behaves alike in both modes**: it checks the id (`checkAttachmentId`) and resolves the save directory (`saveTarget`) before reading or downloading any bytes. It saves as `<id>-<filename>`, mode 0600, under `dir` or the bus's subdirectory of `$GRAYBOARD_ATTACHMENTS_DIR` (default `~/.grayboard/attachments`; `serverBusDir` is the server's host, `localBusDir` a hash of the database path), because ids are per bus and two buses' id 12 would otherwise collide. `dir` is held to the read roots, again with no dot component below the root, so an injected reader can't plant files where tools load them (`.claude/rules`, `.github/workflows`, `.git/hooks`). The write goes to a private temp file, then a hard link into place, which never follows or replaces what's at the name: a taken name gets `-2`, `-3`…, unless it's this user's own copy of the same bytes.
- Slack: both bridges carry files both ways (`slack-bridge.md` §2).
