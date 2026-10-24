# grayboard-opencode

Standalone OpenCode **v2** integration for hosted Grayboard. Version 1.10.0 targets the published OpenCode 2.1.4 plugin API and the official MCP client 2.4.0. It does not replace the existing local/V1 adapter and never starts Grayboard, a stdio proxy, or a custom WebSocket receiver. Remote OpenCode needs no Grayboard CLI.

The native HTTP MCP connection supplies agent tools, server instructions, sign-in, credential storage and refresh. This package supplements it with an in-process `2026-07-28` resource subscriber and durable root-session admission. It registers no agent tools and creates no OAuth grant or refresh handler.

## Build and install

This directory is an independent package; root typechecking does not cover it.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
npm pack --ignore-scripts
```

The package is not published by these commands. Install the resulting tarball into a dedicated directory, or use this built package directory. OpenCode loads a package/directory, not a tarball URL. Loadable root `index.js`/`tui.js` entries and the main/optional `./tui` package exports are included for directory discovery; generated `dist/`, dependencies and tarballs are ignored.

Example `opencode.json` (replace the registered example server/client and directory):

```json
{
  "plugins": [
    {
      "package": "/path/to/installed/grayboard-opencode",
      "options": {
        "mcpName": "grayboard",
        "issuer": "https://grayboard.example.com/hosted"
      }
    }
  ],
  "mcp": {
    "servers": {
      "grayboard": {
        "type": "remote",
        "url": "https://grayboard.example.com/hosted/mcp",
        "headers": { "X-Grayboard-Identity": "be" },
        "oauth": {
          "client_id": "opencode-native",
          "scope": "grayboard:tools grayboard:delivery"
        }
      }
    }
  }
}
```

The native entry must already exist, be enabled, use OAuth and have both scopes. Static Authorization, subscriber-role and lease headers are refused. The package does not mutate or overwrite that entry. With no options it uses native entry `grayboard`. If native `oauth.auth_server_metadata_url` is absent, the package derives only Grayboard's embedded-AS discovery route from the fixed canonical HTTPS resource: `/mcp` maps to `/.well-known/oauth-authorization-server`, and `/hosted/mcp` maps to `/.well-known/oauth-authorization-server/hosted`. The final literal `/mcp` is required; ambiguous/unsupported paths, queries and userinfo are refused rather than guessing an external issuer. An explicit HTTPS `oauth.auth_server_metadata_url` overrides that derivation and remains a guarded configuration field.

During explicit enrollment, the package reads the selected HTTPS metadata without access/lease/secret headers, with redirects rejected and a timeout. Its response supplies the trusted **exact** issuer; optional plugin `issuer` additionally pins that string, including any significant explicit port/path. Deriving the metadata URL does **not** derive or normalize the issuer identifier: metadata may declare `https://grayboard.example.com:443/hosted` while the canonical resource is `https://grayboard.example.com/hosted/mcp`. The authenticated identity must match both independently. Neither a Host header nor an unstamped native credential establishes the issuer. This read-only metadata lookup is not a second OAuth flow; native MCP still owns sign-in, discovery, the grant and refresh.

Use OpenCode's native `/mcps` sign-in interface. Missing/expired credentials are reported; the subscriber cannot force native refresh. OpenCode remains the sole grant and refresh owner, including its known 2.1.4 native refresh-concurrency limitation.

OpenCode automatically loads `./tui` alongside the package. For a separately installed CLI talking to a remote OpenCode server, install the companion locally too and enable its package directory under the CLI's `plugins` array. The TUI uses the connected server's public RPC API; no local Grayboard executable is needed.

## Explicit enrollment and controls

Open an active **root** session, then run `/grayboard-enroll` or the **Grayboard: enroll current root** palette action and confirm. `/grayboard-pause` stops delivery; `/grayboard-status` reports status. The root is taken from the current session route, not the last user message. Child, archived and deleted targets are refused. No enrollment means no lease, subscriber owner or inbox consumption.

The exported `Grayboard` RPC schema provides `status({})`, `enroll({sessionID})`, and `pause({})` through `client.rpc(Grayboard)` at the selected location. RPC is an authenticated host control surface, not cryptographic proof of human intent; the companion asks for confirmation. An operator may alternatively set `rootSessionID` in plugin options for explicit initial enrollment. Do not set it to an automatically chosen session.

Enrollment reads the authenticated `grayboard://identity` before opening delivery. User ID/email, simple/full identity, exact issuer, canonical resource, native configuration, integration ID, selected connection ID and target root are persisted in `session.metadata["grayboard.enrollment"]`. Plugin storage retains only the explicit root pointer, an enrollment fingerprint, pause state and a rejected-access fingerprint; it stores no credential, bearer or lease capability. Restore requires that pointer/options and a still-matching enabled root tuple whose fingerprint matches protected plugin storage; editing metadata cannot authorize a replacement tuple. Startup restoration is deferred so other plugins can finish configuring native MCP, with a bounded five-second public-read readiness window. A pause or observed binding drift is latched across reload; switching configuration/accounts back does not resume it. Explicit enrollment is required again.

## Binding and authorization

Every request projects **only current access** from public APIs: a fresh temporary tail `mcp.transform` reads selected effective configuration fields; `mcp.list` supplies integration ID; `integration.connection.active` supplies selected credential ID; `integration.get` supplies projected connection status; `connection.resolve` supplies OAuth type/expiry/access. Every explicitly observed integration/selected-credential ID is compared with enrollment before resolution; an observed mismatch latches refusal even if selection subsequently switches back. Configuration is checked again immediately before resolution, and configuration/selection are checked again afterward. No refresh property, private credential file, native rotating grant, copied credential object or cached bearer is used.

The endpoint, identity, OAuth client, normalized scopes, discovery pointer and selected connection are fixed by enrollment. Drift pauses/cancels old work. The HTTP destination is fixed and redirects are rejected. Events are advisory; selection events can latch a pause but do not establish token freshness. A subscriber 401 stops that subscriber and remembers a one-way access fingerprint, without modifying native MCP status or retrying unchanged rejected access. Recovery requires restored native access, explicit enrollment and an actual authorized request, not an event.

OpenCode 2.1.4 provides no public configuration revision/CAS or atomic guard-plus-admission transaction. These are repeated best-effort public-state checks, not an atomic security snapshot. Operators must not treat a configuration event as proof of freshness or an arbitrary metadata edit as enrollment.

## Delivery and receipts

After explicit enrollment, the subscriber opens one delivery lease. The capability exists only in memory and is sent in `X-Grayboard-Lease`, never in a URI. It waits for a `subscriptions/listen` acknowledgment honoring `grayboard://inbox` **before** reading durable pending items. Renewals occur about every ten seconds for a thirty-second server lease; renewal also relistens and reconciles missed hints. Transport loss uses bounded, cancelable exponential backoff (eight interruptions, capped at eight seconds per delay); the SDK is not assumed to replay or relisten. On an expired/not-found lease the old capability is retired. Reacquisition requires another actual authenticated identity read matching the enrolled user ID/email, exact issuer/resource and simple/full identity, plus unchanged native configuration/selected credential and a valid root enrollment. Recovery is bounded to three lease retirements per run. A same-logical-user native reauthorization can therefore recover without a new root enrollment; an observed account/configuration/selected-credential change always latches a pause. Opaque grant-only changes are not observable from the identity resource and are not claimed to be detected. Authorization is always revalidated by the server; no stale-access fallback is used.

Admissions and receipts are serialized. Each item is rendered as untrusted channel/user data and sent using `session.synthetic`, delivery `queue`, metadata source `grayboard`, and `resume` equal to the item's actionable flag. Stable IDs are `msg_` plus SHA-256 of a versioned authenticated-user/issuer/resource/full-identity/item/target-root tuple, independent of access rotation. After awaiting durable host acceptance, the package rechecks root/binding and receipts that one item. First admission/receipt failure stops the prefix; later direct messages are never receipted past it. Retry reuses the stable ID, relying on durable first-wins host deduplication. A receipt is not processing completion, a DM acknowledgment, or an exactly-once execution guarantee.

`resume:false` suppresses an idle wake only. A deferred digest can receive its own model evaluation when a later actionable item wakes execution; it is not permanently context-only. Payloads and batches are bounded; malformed/oversized items remain pending rather than being silently acknowledged. Server receipt-capacity exhaustion stops delivery for explicit operator recovery rather than dropping dedupe records.

Pause/reload/shutdown cancels the loop and closes streams. Cleanup releases an old lease only with fresh access and a still-matching public binding. It never retargets cleanup or uses a cached credential after an account/configuration change; otherwise the server's thirty-second expiry removes ownership. In particular, embedded-host shutdown can make public MCP/integration services unavailable before plugin cleanup, so shutdown may rely on that bounded expiry rather than an immediate release; an explicit pause while the host is running releases promptly. Deleted/archived roots are rechecked before admission and receipt. In-flight public guard/admission races cannot be made atomic by this package.

## Verification

`bun test` covers deterministic IDs, payload bounds and contiguous-prefix failure/retry semantics. `bun run test:host` builds and packs the package, installs the local tarball into a directory, checks exports, strictly typechecks the fixture, then loads the installed main entry in the actual embedded OpenCode 2.1.4 runtime. Set an approved isolated scratch directory first:

```sh
GRAYBOARD_PACKAGE_TEST_DIR=/path/to/approved/scratch bun run test:host
```

The fixture snapshots the current Grayboard source into that scratch directory; no absolute checkout imports are committed. It uses the actual Grayboard AS/MCP, real native OAuth code/PKCE/consent/callback handling, a trusted fake Google exchange and a loopback fake model. All fixture listeners bind IPv4 explicitly; the child receives only PATH and scratch HOME/XDG/TMPDIR. External traffic is denied before I/O. The installed package's setup runs with real host context; no plugin options are supplied, and only a one-shot admission fault is fixture-injected. No global OpenCode service/config/credentials or real Google/model is used.

The host fixture exercises explicit/invalid roots, native tools, listen acknowledgment, missed hints, digest idle/actionable wake, admission failure, lost/failed receipts, native access rotation, an actual second native account authorization, binding drift/switch-back, lease expiry, revoked access, cleanup and SQLite reopen. TUI controls are strictly typechecked against published APIs and the `./tui` export is resolved in the install test; an interactive TUI was not run. Real browser/TLS/deployment behavior, multi-process ownership, crash/power-loss recovery and atomic account-switch admission are not claimed.
