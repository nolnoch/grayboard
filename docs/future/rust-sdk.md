# Rust client SDK

```doc-meta
owns: the unbuilt rest of the Rust client SDK for hosted MCP (#929): typed tools beyond bind/board_subscribe/board_post, the conformance driver, the service credential, CI wiring and release
invariants: the SDK speaks only modern MCP (`2026-07-28`) as raw JSON-RPC over HTTP, never `rmcp` or the legacy sessionful transport; its requests equal hosted-core's reference wire, checked against a recorded fixture, not against the SDK's own idea of the envelope; only a body-driven 429 (`rate_limited`) and one credential-replaced 401 retry, and a `tools/call` that times out, loses its connection or gets a gateway status is `OutcomeUnknown`, never retried; delivery lands before typed tools so no release is a poll-only client (principle 3); the crate version equals package.json's; the workflow and Dependabot edits are the maintainer's PR (principle 14)
code-pointers: sdk/rust/grayboard/src/ (session.rs, credential.rs), sdk/rust/schema/, scripts/record_rust_fixtures.ts, scripts/snapshot_native_tools.ts, scripts/e2e.sh (rust-sdk), tests/integration/rust_sdk.test.ts, rust_fixtures.test.ts, rust_sdk_version.test.ts, adapters/hosted-core/src/wire.ts, tests/conformance/driver.ts
companions: ../sdk-rust.md (the as-built SDK), ../server-hosted-mcp.md §2 (the server contract), service-principals.md (#270: the credential and run tokens step 6 consumes), ../vision.md (principles 2, 3, 10, 12, 14), ../parity.md
trigger: in progress under #929; steps 4 and 5 need no trigger, step 6 waits on #270's token route
last-verified: 2026-11-16 (origin/master 06dba19f)
```

## Problem

Rust platform services must join the bus as service principals (#270, #807 Stage 3 exit test). The SDK must speak hosted-core's wire, carry push delivery (a queue board routes only to push subscribers, `queueLanes` in `src/core/boards.ts`; principle 3 forbids a poll-only path), fail CI when the tool surface moves, and take #270's credential without a redesign.

## Built (steps 1 to 3)

The transport, raw calls, the delivery stream, typed `bind`/`board_subscribe`/`board_post` and the Stage 3 example: as-built in `../sdk-rust.md` and the crate's docs. Not yet built from step 1: `Driver.label`, which only the conformance driver (step 5) needs.

## D3. Service credential

- `Credential` is two `BoxFuture` methods (`token`, `unauthorized`), so `Client` holds `Arc<dyn Credential>` and the delivery task can be spawned; same shape as hosted-core's `AuthProvider` (`client.ts`).
- After #270's token route: `ClientCredentials { issuer, client_id, secret }` fetches authorization-server metadata once and refuses an issuer mismatch, posts `grant_type=client_credentials` (`client_secret_basic`, `resource` = the MCP endpoint), caches, re-mints at 80% of lifetime (the server closes listen streams at access expiry, so a token must never lapse under one), and re-mints once on `unauthorized`. The caller pins the issuer.
- Not built: browser PKCE, refresh rotation, a grant store (no Rust caller is a person; principle 12).
- Until then, tests register an operator client `rust-sdk-test` with `sessionSource: true` and seed its token (`issueOAuth`). The seed is SQLite-shaped; if #270 slips past the Postgres cutover (#807) the suite needs a Postgres seed.

## D4. Typed methods

- The rest of the typed methods (`board_read`, `claim_take`, `dm_send`, `dm_inbox`, `dm_ack`, …) wrap `call_raw` and return `Result<T, Error>` as the built `bind`, `board_subscribe` and `board_post` do (`../sdk-rust.md`): refusals compare codes, never text (#926, `wire.ts`); `"ok"` text is unit success, a JSON text block is the value, extra text blocks are `notices: Vec<String>`.

## D5. Typed tools and how a schema change fails CI

1. A `src/core/tools.ts` change fails `tests/integration/hosted_core_snapshot.test.ts` until `bun scripts/snapshot_native_tools.ts` regenerates the snapshots, including `sdk/rust/schema/{native,subscriber}-tools.json` (built). No cargo needed.
2. In Rust, each request struct derives `schemars::JsonSchema` under test. A test compares, per tool, property names, required set, primitive types and enums against the vendored snapshot, and fails on a tool with no struct; `Option<T>` counts as optional, not `T | null`. A second test serializes a sample of each struct (`skip_serializing_if = "Option::is_none"`, `deny_unknown_fields`) and validates it against the snapshot (`additionalProperties: false` catches a rename).
- Responses have no schema (no tool declares `outputSchema`). Structs are tolerant readers; a bun script records one real response per tool into `sdk/rust/schema/responses/` with a drift test, and Rust deserializes each. `call_raw` is the backstop.
- Rejected: build-time codegen (`typify`): an added optional argument compiles clean, so a schema change wouldn't fail CI, and generated names become public API. `outputSchema` on every tool: every session pays for `tools/list` on every start (principle 2); a follow-up measures the cost first.

## D7. Conformance and the example

- `conformance-driver` (a workspace member, `publish = false`) speaks JSON lines on stdio, one process per bus: `{"id","op":"peer","peer","url","token","session"}` opens a session and binds with `create: true` in push mode; `{"id","op":"call","peer","tool","args"}` answers `{"id","result":<raw CallToolResult>}`; `{"op":"close"}` ends sessions. The raw result lets `outcome()` in `tests/conformance/driver.ts` be reused unchanged.
- `rustDriver()` joins `DRIVERS` only when `GRAYBOARD_RUST_DRIVER=<binary>` is set. `Driver` gains `label` (`hosted/rust`) while `mode` stays `"hosted"`, so mode-tagged scenarios apply as written. Each bus is a `ServerProcess` with the operator client.
- Conformance covers `call_raw`, the transport, the envelope and the bind rule; no scenario reads deliveries, so the lease is covered by `delivery_tests.rs` and the example (`../sdk-rust.md`).
- Rejected: porting scenarios to Rust (two copies drift, #926).

## D8. CI

- `scripts/e2e.sh rust-sdk` owns every step (built): the toolchain `sdk/rust/rust-toolchain.toml` names, `cargo fmt --check`, clippy `-D warnings`, `cargo test --locked`, the example against a real server. Step 5 adds the driver build, `bun run build` and the conformance run. Not named `hosted-*`: `tests/integration/ci_sources.test.ts` requires every `hosted-*` matrix entry to be a hosted OpenCode suite, and the frozen-install step runs for any `hosted-` prefix.
- The workflow edit is the maintainer's PR (principle 14): a `hosted.yml` matrix entry `rust-sdk`, an `actions/cache` step behind `if: matrix.suite == 'rust-sdk'` for `~/.cargo/registry`, `~/.cargo/git` and `sdk/rust/target` keyed on `Cargo.lock` and the toolchain file, the matching `ci_sources.test.ts` and `hosted_ci.test.ts` updates, and Dependabot's `cargo` entry. Until it lands, the suite runs by hand and each SDK PR records its run.
- Once in the matrix, the `Hosted required` aggregate and `release.yml`'s call to `hosted.yml` make the SDK gate merges and releases with no ruleset edit.
- Rejected: a separate `rust` job in `test.yml` (a ruleset change and a second release gate); cargo in the root `test` job or the pre-push hook.

## D9. Release and versioning

- A git dependency by release tag (`publish = false`). The crate stays out of user-facing docs until a pilot proves the API.
- crates.io after a pilot proves the API, with an MSRV check then. Publishing is irreversible and its token is a supply-chain credential for the `release` environment, a maintainer change (principle 14).
- The SDK refuses a server that doesn't offer `2026-07-28`. Tool arguments are additive; an SDK newer than its server probes for an argument before sending it, as `Wire.takes` does.

## Sequence

4. **Typed tools**: D5's request structs and tests; response fixtures and structs, shown by a deliberate schema edit in the PR.
5. **Conformance driver**: the binary, `rustDriver`, `Driver.label`, the suite green.
6. **After #270's token route**: `ClientCredentials`, the `generic` source, the example with a minted token.

## Open questions, with defaults

1. A blocking API? Default: async on tokio only.
2. Model, effort, launcher and `suggested` `_meta`? Default: the SDK sends none but lets a caller set them.

## Risks

- **R1.** The raw transport tracks a moving protocol. `tests/integration/rust_fixtures.test.ts` fails when hosted-core's envelope changes: the signal to re-check the Rust transport and re-evaluate `rmcp` (3.x has `2026-07-28` and listen, but the per-request lease header, the re-read bearer, the 429 rule and discover's `_meta` would each need a custom `StreamableHttpClient`).
- **R2.** The delivery stream is a second implementation of the lease rules (`../sdk-rust.md`).
- **R3.** Response typing is best-effort until `outputSchema` is decided.
