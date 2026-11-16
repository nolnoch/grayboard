# Rust client SDK

```doc-meta
owns: the unbuilt rest of the Rust client SDK for hosted MCP (#929): typed tools, the delivery stream, the conformance driver, the service credential, CI wiring and release
invariants: the SDK speaks only modern MCP (`2026-07-28`) as raw JSON-RPC over HTTP, never `rmcp` or the legacy sessionful transport; its requests equal hosted-core's reference wire, checked against a recorded fixture, not against the SDK's own idea of the envelope; only a body-driven 429 (`rate_limited`) retries, and a `tools/call` that times out or loses its connection is `OutcomeUnknown`, never retried; delivery lands before typed tools so no release is a poll-only client (principle 3); the crate version equals package.json's; the workflow and Dependabot edits are the maintainer's PR (principle 14)
code-pointers: sdk/rust/grayboard/src/ (transport.rs, session.rs, envelope.rs, credential.rs), sdk/rust/schema/, scripts/record_rust_fixtures.ts, scripts/snapshot_native_tools.ts, scripts/e2e.sh (rust-sdk), tests/integration/rust_sdk.test.ts, rust_fixtures.test.ts, rust_sdk_version.test.ts, adapters/hosted-core/src/wire.ts, adapters/hosted-core/src/controller.ts (the lease protocol D6 ports), tests/conformance/driver.ts
companions: ../server-hosted-mcp.md §2 (the as-built transport and its fixtures), service-principals.md (#270: the credential and run tokens step 6 consumes), ../vision.md (principles 2, 3, 10, 12, 14), ../parity.md
trigger: in progress under #929; steps 3 to 5 need no trigger, step 6 waits on #270's token route
last-verified: 2026-11-16 (origin/master 72ce9d68)
```

## Problem

Rust platform services must join the bus as service principals (#270, #807 Stage 3 exit test). The SDK must speak hosted-core's wire, carry push delivery (a queue board routes only to push subscribers, `queueLanes` in `src/core/boards.ts`; principle 3 forbids a poll-only path), fail CI when the tool surface moves, and take #270's credential without a redesign.

## Built (steps 1 and 2)

The transport, `Credential` with `StaticBearer`, `call_raw`, `call_subscriber`, `read_resource`, `listen` and `end`; the stripped schema snapshots; the wire fixture; the `rust-sdk` suite. As-built facts: `../server-hosted-mcp.md` §2 and the crate's own docs. Not yet built from step 1: `Driver.label`, which only the conformance driver (step 5) needs.

## D3. Service credential

- `Credential` is two `BoxFuture` methods (`token`, `unauthorized`), so `Client` holds `Arc<dyn Credential>` and the delivery task can be spawned; same shape as hosted-core's `AuthProvider` (`client.ts`).
- After #270's token route: `ClientCredentials { issuer, client_id, secret }` fetches authorization-server metadata once and refuses an issuer mismatch, posts `grant_type=client_credentials` (`client_secret_basic`, `resource` = the MCP endpoint), caches, re-mints at 80% of lifetime (the server closes listen streams at access expiry, so a token must never lapse under one), and re-mints once on `unauthorized`. The caller pins the issuer.
- Not built: browser PKCE, refresh rotation, a grant store (no Rust caller is a person; principle 12).
- Until then, tests register an operator client `rust-sdk-test` with `sessionSource: true` and seed its token (`issueOAuth`). The seed is SQLite-shaped; if #270 slips past the Postgres cutover (#807) the suite needs a Postgres seed.

## D4. API shape

- Typed methods (`bind`, `board_subscribe`, `board_post`, `board_read`, `claim_take`, `dm_send`, `dm_inbox`, `dm_ack`, …) wrap `call_raw` and return `Result<T, Error>`; refusals compare codes, never text (#926, `wire.ts`). Readers: `"ok"` text is unit success, a JSON text block is the value, extra text blocks are `notices: Vec<String>`.
- `session.deliveries()` is a `Stream<Item = Result<Delivery, Error>>`, one item at a time. `Delivery` carries `id`, `actionable`, `event`, `stable_id`, the trust marks `other_user`, `ungranted`, `delegated` as typed fields, and `receipt()`. Services never act on an `ungranted` item and treat `other_user` as another account's data (principle 10).
- `receipt()` is durable acceptance, not completion. While an item is handed out and not receipted, a background task renews the lease, so slow acceptance doesn't outlive the 30 s TTL.
- The SDK owns the bind rule: `bind`/`unbind` stops delivery before the call and reopens it after under the new holds (`controller.ts`; `tests/conformance/driver.ts`). `end()` releases the lease, then calls `session_end`.
- At-least-once: a crash between taking an item and its receipt shows it again; `stable_id` is for the consumer's idempotence, and the crate docs must say so.

## D5. Typed tools and how a schema change fails CI

1. A `src/core/tools.ts` change fails `tests/integration/hosted_core_snapshot.test.ts` until `bun scripts/snapshot_native_tools.ts` regenerates the snapshots, including `sdk/rust/schema/{native,subscriber}-tools.json` (built). No cargo needed.
2. In Rust, each request struct derives `schemars::JsonSchema` under test. A test compares, per tool, property names, required set, primitive types and enums against the vendored snapshot, and fails on a tool with no struct; `Option<T>` counts as optional, not `T | null`. A second test serializes a sample of each struct (`skip_serializing_if = "Option::is_none"`, `deny_unknown_fields`) and validates it against the snapshot (`additionalProperties: false` catches a rename).
- Responses have no schema (no tool declares `outputSchema`). Structs are tolerant readers; a bun script records one real response per tool into `sdk/rust/schema/responses/` with a drift test, and Rust deserializes each. `call_raw` is the backstop.
- Rejected: build-time codegen (`typify`): an added optional argument compiles clean, so a schema change wouldn't fail CI, and generated names become public API. `outputSchema` on every tool: every session pays for `tools/list` on every start (principle 2); a follow-up measures the cost first.

## D6. The delivery stream

Ports the lease protocol in `Controller.run` (`adapters/hosted-core/src/controller.ts`). Not ported, as harness-host concerns: approval, guard, drift, rotation grace, children, diagnostics. A change to `controller.ts`'s delivery rules must name its Rust counterpart; only these tests and the example catch drift.

| Rule | Reference |
|---|---|
| Open: `whoami`; if nothing is held, bind the remembered holds with `create: false`; if holds differ from expected, stop | `controller.ts` open |
| `whoami` reports `alias_lost`: drop those holds; if none remain, stop with `AliasLost` | `controller.ts` |
| A native result with `unbound: true` or `_meta[…/alias_lost]`: stop delivery, rebind the remembered holds, reopen | `controller.ts`, `src/server/mcp.ts` |
| `delivery_open` returns `capability` (43 url-safe chars), `ownership`, `bind_gen`, `expiresAt`, identity; validate, then send the capability as `X-Grayboard-Lease` | `model.ts` |
| Listen on `grayboard://inbox`; require it in the honored filter (built) | `wire.ts` |
| A hint only marks the inbox dirty; read `grayboard://inbox` (first read unconditional); 100 items means read again | `controller.ts` |
| No client cursor: the server's position is the receipt | `controller.ts` |
| Per item, in order: check `ownership`/`bind_gen`/`address` against the lease, `delivery_renew`, hand over, renew in the background until `receipt()`, then `delivery_receipt({ ids: [id] })` | `controller.ts`, `model.ts` |
| Dedup: keys `ownership:bind_gen:id` handed over but not receipted survive reconnects in-process (cap 100); a retry goes straight to the receipt | `controller.ts` |
| Durable dedup is the consumer's: `stable_id` hashes principal, issuer, resource, address, item ID and session ID | `model.ts` |
| Renew every 10 s while idle or holding an item (TTL 30 s, `src/server/hosted.ts`); a renew re-reads the inbox | `controller.ts` |
| Stream closed or unreachable: reopen from `whoami`, backoff `min(8 s, 250 ms * 2^n)`, no limit, reset by a healthy renew or receipt | `controller.ts` |
| Lease lost (`not_found`/`unbound` on a `delivery_*` call): reopen; more than 3 losses outside an item stops | `wire.ts`, `controller.ts` |
| An item attempted more than 8 times, or 8 other failures in a row: stop and report the item | `controller.ts` |
| `alias_held`, `identity_unknown`: stop at once | `controller.ts` |
| `receipt_capacity`: `delivery_release`, then reopen | `controller.ts` |
| Admission-throttled reopen: wait `max(retry_after_ms, min(8 s, 500 ms * 2^n))`, 8 tries | `controller.ts` |
| Close or cancel: `delivery_release`, then `session_end` | `controller.ts` |

- A delivery receipt is not `dm_ack` (the agent's answer). "Stop" is the stream's terminal error with its code; the service decides. Each row gets a Rust test against the scripted fake endpoint.

## D7. Conformance and the example

- `conformance-driver` (a workspace member, `publish = false`) speaks JSON lines on stdio, one process per bus: `{"id","op":"peer","peer","url","token","session"}` opens a session and binds with `create: true` in push mode; `{"id","op":"call","peer","tool","args"}` answers `{"id","result":<raw CallToolResult>}`; `{"op":"close"}` ends sessions. The raw result lets `outcome()` in `tests/conformance/driver.ts` be reused unchanged.
- `rustDriver()` joins `DRIVERS` only when `GRAYBOARD_RUST_DRIVER=<binary>` is set. `Driver` gains `label` (`hosted/rust`) while `mode` stays `"hosted"`, so mode-tagged scenarios apply as written. Each bus is a `ServerProcess` with the operator client.
- Conformance covers `call_raw`, the transport, the envelope and the bind rule; no scenario reads deliveries, so the lease is covered by D6's tests and the example.
- The example (`examples/roundtrip.rs`, today bind and post) grows to the Stage 3 path: bind; `board_subscribe` a queue board in push mode; a TS counterpart posts a work item; take it through `deliveries()`, `receipt()` it, reply in thread; receive a DM, `dm_ack` it, end. `tests/integration/rust_sdk.test.ts` asserts on server state afterwards.
- Rejected: porting scenarios to Rust (two copies drift, #926).

## D8. CI

- `scripts/e2e.sh rust-sdk` owns every step (built): the toolchain `sdk/rust/rust-toolchain.toml` names, `cargo fmt --check`, clippy `-D warnings`, `cargo test --locked`, the example against a real server. Step 5 adds the driver build, `bun run build` and the conformance run. Not named `hosted-*`: `tests/integration/ci_sources.test.ts` requires every `hosted-*` matrix entry to be a hosted OpenCode suite, and the frozen-install step runs for any `hosted-` prefix.
- The workflow edit is the maintainer's PR (principle 14): a `hosted.yml` matrix entry `rust-sdk`, an `actions/cache` step behind `if: matrix.suite == 'rust-sdk'` for `~/.cargo/registry`, `~/.cargo/git` and `sdk/rust/target` keyed on `Cargo.lock` and the toolchain file, the matching `ci_sources.test.ts` and `hosted_ci.test.ts` updates, and Dependabot's `cargo` entry. Until it lands, the suite runs by hand and each SDK PR records its run.
- Once in the matrix, the `Hosted required` aggregate and `release.yml`'s call to `hosted.yml` make the SDK gate merges and releases with no ruleset edit.
- Rejected: a separate `rust` job in `test.yml` (a ruleset change and a second release gate); cargo in the root `test` job or the pre-push hook.

## D9. Release and versioning

- A git dependency by release tag (`publish = false`). The crate stays out of user-facing docs until the delivery stream lands, so no release advertises a poll-only client.
- crates.io after a pilot proves the API, with an MSRV check then. Publishing is irreversible and its token is a supply-chain credential for the `release` environment, a maintainer change (principle 14).
- The SDK refuses a server that doesn't offer `2026-07-28`. Tool arguments are additive; an SDK newer than its server probes for an argument before sending it, as `Wire.takes` does.

## Sequence

3. **Delivery stream**: D6 with its tests, typed `bind`/`board_subscribe`/`board_post`, the example completed.
4. **Typed tools**: D5's request structs and tests; response fixtures and structs, shown by a deliberate schema edit in the PR.
5. **Conformance driver**: the binary, `rustDriver`, `Driver.label`, the suite green.
6. **After #270's token route**: `ClientCredentials`, the `generic` source, the example with a minted token.

## Open questions, with defaults

1. A blocking API? Default: async on tokio only.
2. Model, effort, launcher and `suggested` `_meta`? Default: the SDK sends none but lets a caller set them.

## Risks

- **R1.** The raw transport tracks a moving protocol. `tests/integration/rust_fixtures.test.ts` fails when hosted-core's envelope changes: the signal to re-check the Rust transport and re-evaluate `rmcp` (3.x has `2026-07-28` and listen, but the per-request lease header, the re-read bearer, the 429 rule and discover's `_meta` would each need a custom `StreamableHttpClient`).
- **R2.** D6 is a second implementation of the lease rules (above).
- **R3.** Response typing is best-effort until `outputSchema` is decided.
