# Rust client SDK

```doc-meta
owns: the unbuilt rest of the Rust client SDK for hosted MCP (#929): release and versioning (crates.io after a pilot), and the CI wiring's rationale
invariants: the SDK speaks only modern MCP (`2026-07-28`) as raw JSON-RPC over HTTP, never `rmcp` or the legacy sessionful transport; its requests equal hosted-core's reference wire, checked against a recorded fixture, not against the SDK's own idea of the envelope; only a body-driven 429 (`rate_limited`) and one credential-replaced 401 retry, and a `tools/call` that times out, loses its connection or gets a gateway status is `OutcomeUnknown`, never retried; the crate version equals package.json's; the workflow and Dependabot edits are the maintainer's PR (principle 14)
code-pointers: sdk/rust/grayboard/Cargo.toml, scripts/e2e.sh (rust-sdk), tests/integration/rust_sdk_version.test.ts, .github/workflows/hosted.yml (rust-sdk)
companions: ../sdk-rust.md (the as-built SDK, its service credential included), ../server-hosted-mcp.md §2 (the server contract), ../vision.md (principles 2, 3, 10, 12, 14), ../parity.md
trigger: a pilot service proves the API (D9)
last-verified: 2026-11-19 (origin/master c247412e)
```

## Problem

Rust platform services must join the bus as service principals (#270, #807 Stage 3 exit test). The SDK must speak hosted-core's wire, carry push delivery (a queue board routes only to push subscribers, `queueLanes` in `src/core/boards.ts`; principle 3 forbids a poll-only path), fail CI when the tool surface moves, and take #270's credential without a redesign.

## Built (steps 1 to 6)

The transport, raw calls, the delivery stream, the Stage 3 example, typed tools (a struct and method per native tool, and how a schema change fails CI), the conformance driver and the service credential (`ClientCredentials`, the `generic` source, the example and the conformance run minting their own tokens): as-built in `../sdk-rust.md` (§4 for the driver, §5 for the credential) and the crate's docs.

## D8. CI

- `scripts/e2e.sh rust-sdk` owns every step (built): the toolchain `sdk/rust/rust-toolchain.toml` names, `cargo fmt --check`, clippy `-D warnings`, `cargo test --locked`, the example against a real server, the conformance driver's build, `bun run build` and the conformance run (step 5's additions). Not named `hosted-*`: `tests/integration/ci_sources.test.ts` requires every `hosted-*` matrix entry to be a hosted OpenCode suite, and the frozen-install step runs for any `hosted-` prefix.
- The workflow edit landed as the maintainer's PR (#983, principle 14): the `hosted.yml` matrix entry `rust-sdk` with its cargo cache, the matching `ci_sources.test.ts` and `hosted_ci.test.ts` updates, and Dependabot's `cargo` entry.
- In the matrix, the `Hosted required` aggregate and `release.yml`'s call to `hosted.yml` make the SDK gate merges and releases with no ruleset edit.
- Rejected: a separate `rust` job in `test.yml` (a ruleset change and a second release gate); cargo in the root `test` job or the pre-push hook.

## D9. Release and versioning

- A git dependency by release tag (`publish = false`). The crate stays out of user-facing docs until a pilot proves the API.
- crates.io after a pilot proves the API, with an MSRV check then. Publishing is irreversible and its token is a supply-chain credential for the `release` environment, a maintainer change (principle 14).
- The SDK refuses a server that doesn't offer `2026-07-28`. Tool arguments are additive; an SDK newer than its server probes for an argument before sending it, as `Wire.takes` does. Not built: every argument struct is this release's snapshot, which a server of the same version takes; the first argument added after a release gets the probe in its typed method.

## Sequence

Steps 1 to 6 are built. What remains is D9's release after a pilot.

## Open questions, with defaults

1. A blocking API? Default: async on tokio only.
2. Model, effort, launcher and `suggested` `_meta`? Default: the SDK sends none but lets a caller set them.

## Risks

- **R1.** The raw transport tracks a moving protocol. `tests/integration/rust_fixtures.test.ts` fails when hosted-core's envelope changes: the signal to re-check the Rust transport and re-evaluate `rmcp` (3.x has `2026-07-28` and listen, but the per-request lease header, the re-read bearer, the 429 rule and discover's `_meta` would each need a custom `StreamableHttpClient`).
- **R2.** The delivery stream is a second implementation of the lease rules (`../sdk-rust.md`).
