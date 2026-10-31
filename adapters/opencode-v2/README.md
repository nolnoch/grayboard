# grayboard-opencode

Standalone hosted Grayboard integration targeting the published OpenCode **2.1.4** API and official MCP client **2.4.0**. Native HTTP MCP remains the only agent-tool, OAuth, credential-storage and refresh owner. This package adds session ancestry registration and human-approved durable delivery; it registers no agent tools, runs no CLI/proxy and never reads a refresh token or private credential file.

## Install from Git

Use a reviewed, publicly available **full 40-character commit hash** containing this package:

```sh
opencode plugin add 'github:nolnoch/grayboard#<FULL_40_CHARACTER_SHA>::path:adapters/opencode-v2'
```

Replace the placeholder with the complete hash, not a branch, tag or abbreviated hash. Confirm that revision is on GitHub before recommending it. Package exports and directory wrappers load packaged TypeScript `src/` directly: no build command, generated `dist/`, install script or lifecycle hook is required. The server entry is a native Effect plugin; it inherits the host logger and adapts its Promise lifecycle through the public adapter, rather than exposing a Promise `setup` entry. A local source-only Git fixture verifies installation mechanics, not public availability of a future revision. Tarball installation is separate and does not satisfy the Git verification gate.

## Configuration

```json
{
  "plugins": [{ "package": "/path/to/installed/grayboard-opencode", "options": { "mcpName": "grayboard" } }],
  "mcp": { "servers": { "grayboard": { "type": "remote", "url": "https://grayboard.example.com/hosted/mcp" } } }
}
```

Use native `/mcps` to sign in. No explicit OAuth client/scopes block or identity header is required. The selected native grant must authorize both `grayboard:tools` and `grayboard:delivery`. Current access and exact issuer/client/scope come from public connection projection; incomplete metadata or expired access fails closed. `Authorization`, `X-Grayboard-Identity`, subscriber-role and lease headers in the native entry are refused. Optional plugin `issuer` pins the exact native issuer string; it is not an endpoint-derived guess.

OpenCode loads the companion `./tui` entry alongside the package. A separate CLI talking to a remote OpenCode server needs the companion installed in its local CLI plugins too. The companion talks to public host RPC; no Grayboard executable is required.

## Approval and binding

`/grayboard-enroll` asks the human to approve the active top-level root for receiving. Approval alone creates no name, lease, cursor movement or receipt. It reports the actual bound name or an unbound state. A native agent `bind` does not approve receiving. Delivery begins only once the root is both approved and bound, in either order.

`/grayboard-enroll <name>` saves approval first, then binds with `create:false`; a refusal leaves approval standing and shows a safe refusal code, with validated account-scoped known names when available, or for a held name the server's validated description of the holding session. Add `--create` for explicit creation. Optional plugin `name` binds new root sessions with `create:false`, without enrolling them; plugin `create: true` explicitly permits creation on that startup bind only (other values do not). A configured name is not automatic approval. Separate roots sharing one native config retain separate approvals and delivery targets.

`/grayboard-pause` ends approved roots' ownerships. Their last bound names remain in separate plugin bookkeeping scoped to the approval fingerprint; explicit enrollment resumes with `create:false`, never silently creates a replacement, and stops on a held-name refusal, naming the holder once in that root's status; a restored record drops it. Automatic remembered-name updates cannot grant or re-enable approval. `/grayboard-status` reports all roots' persisted diagnostic states, reasons and times; another root becoming active cannot erase a terminal pause. A root whose session was deleted or archived stays listed as ended, but never becomes the headline state over the live roots. Diagnostics are separate from approval and cannot enroll a root; a restored pause only prevents automatic restart. Host logs contain fixed operations and validated root/name/ownership context, never delivery text, tokens or exception content. A failed log write remains visible without replacing a terminal pause or authorizing its retry. Public RPC exposes `status({})`, `enroll({sessionID,name?,create?})`, and `pause({})`; the companion provides human confirmation, while RPC itself is an authenticated control surface rather than proof of human intent.

## Session attribution and lifecycle

The plugin observes exact native configured tool IDs, including the inner native calls in CodeMode, not its outer `execute` wrapper. Before any descendant Grayboard call it walks `parentID` to the top-level root (at most 16 lookups), rejects missing/repeated/archived ancestry, and awaits `session_register(child,via)` directly under that root. It does not keep a registration cache across ownerships. Native bind completion is accepted only for completed results with validated `result.output`; lease failures are reported after execution, not misrepresented as pre-dispatch rejection.

Subscriber calls carry `_meta["ai.opencode/sessionID"]` from the approved root, using the same current native access. The server's client mapping selects the context source. Roots and children never share delivery targets. Retained routes permit idempotent archive/delete cleanup after host records disappear; child-self `session_end` closes only that child, and root release/end closes the ownership. Host shutdown closes transport without proactively ending ownership, allowing a restart within the server deadline; explicit pause ends ownership immediately when authorized cleanup succeeds.

Native account/configuration drift latches delivery rather than retargeting it. Restoring a saved approval requires both root metadata and the protected plugin-storage fingerprint. No `rootSessionID` startup option manufactures approval. Cleanup requires fresh current access and unchanged binding; when that is unavailable, server expiry remains the backstop.

## Delivery safety

Each lease is validated against the approved endpoint, exact issuer, bound name, ownership and bind generation. Every pending item must match that immutable stamp. Binding owns the name independently of delivery; opening delivery only attaches the approved root's push target. Native rebind fences old admission, keeps approval, and opens delivery under the new binding without the plugin releasing that newly acquired ownership. Lease losses outside an item spend a small recovery budget, reset by a successful renew or receipt; losses inside an item spend that item's retry budget. Only successful receipts reset progress failures; an exhausted item remains unreceipted and pauses that root, even if logging fails. Typed receipt-capacity recovery releases the old capability, rebinds the remembered name with `create:false` and opens a new lease without manufacturing approval. Restart/expiry recovery checks `whoami`, rebinds a remembered name only with `create:false` when unbound, and reopens for the rightful root. A server outage (a failed request `unreachable` in `src/core/wire.ts`, generated from `adapters/hosted-core/src/wire.ts`, classifies) spends neither the failure nor the recovery budget, since the server doesn't count its own downtime against the lease (#423): the root shows `retrying` with capped exponential backoff, reset only by a receipt or the periodic renew. A closed inbox subscription is reopened the same way, but isn't itself an outage: the server also closes it when native access expires. An outage inside an item still spends one of that item's attempts. Native access expiring after a failed request, before `whoami` succeeds again, is retried until native MCP refreshes it; otherwise, including after a closed subscription, it pauses the root.

Admission uses public `session.synthetic`, `delivery:queue`, untrusted channel text, and `resume` equal to the actionable flag. Idle digests do not wake execution, but may be evaluated on a later actionable wake. Stable IDs bind authenticated principal, issuer, resource, name, item and root and survive lease/access rotation. A receipt is sent only after durable host acceptance and another public-state guard; it is distinct from `dm_ack`. Failure/uncertain admission sends no receipt. An item counts as admitted once host admission resolves, keyed by ownership, bind generation and item ID: a lost receipt reopens delivery and receipts that item before later ones without admitting it again in the same process, while a new lease or a restart admits it again.

Public guard and host admission are **not atomic** in OpenCode 2.1.4. An already-authorized in-flight host call can still commit and wake its exact previously approved root across a concurrent pause, rebind, expiry, revocation or account/configuration change. The original target, principal, payload and stable ID remain fixed; observed drift stops subsequent admission and the post-await checks suppress stale receipts. A committed write/wake cannot be recalled. There is no fallback root, cross-account retry, atomic cancellation or exactly-once processing guarantee.

## Build and verification

This independent package is outside root typechecking:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build:package
npm pack --ignore-scripts
```

The explicit compiler command is named `build:package`: Pacote's Git preparation treats a script literally named `build` specially even with outer scripts disabled, and the published OpenCode 2.1.4 SDK's nested npm launcher is absent. No install/prepare/prepack hooks are used. Optional `dist/` remains packable when explicitly built, but source installation never depends on it. The TUI imports the public `tui/plugin` definition subpath, avoiding optional Solid rendering peers.

`GRAYBOARD_PACKAGE_TEST_DIR=/path/to/fresh/approved/scratch bun run test:git` creates a disposable source-only Git repo, pins its full hash and subdirectory, and uses the actual installed public OpenCode 2.1.4 host installer with scripts disabled. It asserts active server/TUI/RPC discovery, actual installed-source imports and directory wrappers, inert unenrolled status, and no `dist/`. It does not test interactive TUI rendering or public GitHub availability.

`GRAYBOARD_PACKAGE_TEST_DIR=/path/to/fresh/approved/scratch bun run test:native-host` first runs the source-only Git installer gate, then exercises that installed package with the actual public OpenCode 2.1.4 host in separate direct-tool and CodeMode processes. A fake discovered OAuth/MCP service supplies native authorization without an explicit OAuth config block. The test asserts approval without binding or leasing, native bind completion to lease, two isolated roots sharing one native grant, awaited grandchild registration through an intermediate parent, and retained child/root lifecycle cleanup. Native and subscriber requests use the same selected access token; no plugin refresh or private credential file access is used. This is host integration against a fake revised service, not validation of the real backend.

Unit tests cover ancestry bounds, native public grant projection, approval/binding order, root isolation, awaited registration, retained lifecycle routes, rebind recovery, pause/resume, immutable batch stamps and admission/receipt failure fences. `test:host` runs the installed plugin with an actual Grayboard server, native CIMD OAuth discovery, source-session metadata, moved claims, mapped child attachments and real receipt cursors. It crosses an OS-process host reload boundary and restarts the durable server before and after the sticky deadline. `test:host-races` holds real public host admission before dispatch or after durable acceptance while lifecycle, account, configuration and lease authority change, then checks actual backend cursors. Its recovery cases kill and restart host processes and distinguish an uncommitted write from an already committed write/wake; they do not assert atomic cancellation or exactly-once execution. The main multi-root lifecycle gate and independent lifecycle cases use an explicit test-only admission budget so rate limiting does not replace their authority assertions; a separate recovery case exhausts the unchanged production-default hosted-request bucket, independent of WSS hello admission, verifies typed HTTP 429 and retries real delivery. Both commands use isolated fixture Google/model services and a logical HTTPS origin routed to the local actual backend. Public exact-SHA GitHub installation remains a separate gate; a disposable local Git fixture is not evidence of public availability.
