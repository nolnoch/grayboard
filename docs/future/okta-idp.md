# Okta as a second upstream IdP

```doc-meta
owns: the design of a second upstream identity provider behind the server's OAuth authorization server (#928): the provider seam, the generic OIDC provider Okta configures, identity keyed by issuer and subject, cross-IdP linking, provider config, the authorize choice, CLI login through the AS
invariants: a user is found by (issuer, subject), never by email alone once any IdP has claimed the row; the stored issuer is a constant per provider, never a token's `iss`; a provider returns an identity only after every check held (signature, issuer, audience, expiry, nonce, verified email, email domain); an email another IdP's account holds never signs into that account; subjectless old rows are stamped only with the column's `ALTER`, while a subject with no issuer is repaired on every open; the login scope is in no list any other client's scopes are drawn from; discovery and JWKS are fetched lazily, never at startup; each provider has its own callback path and the upstream state names its provider
code-pointers: src/server/auth.ts (verifyGoogleIdToken, exchangeGoogleCode, googleSignIn), src/server/oauth.ts (createOAuthServer: OAuthOptions.exchangeGoogle, the authorize and callback routes, flows/upstream), src/server/http.ts (authConfig, authExchange, devLogin, adminUnlinkIdp), src/server/db.ts (users.signIn, IdpSignIn, idx_users_idp_subject), src/server/config.ts (loadConfig, mcpGoogleConfig), src/server/oauth-config.ts (BUILTINS), src/server/audit.ts, src/cli/oauth_flow.ts, src/cli/cli.ts (login), tests/support/hosted_oauth.ts
companions: ../architecture.md §3 and ../server-oauth.md §1 (take the as-built facts), postgres-server.md (the store `signIn` is written against), role-bindings.md R1 and service-principals.md (why neither keys on `idp_subject`), ../vision.md (principles 8, 12, 14), ../parity.md
trigger: #928 scheduled (#807 Stage 3, decision A2): a pilot adopter's Okta-only users can't sign in. Steps 1 to 3 are worth building without it
last-verified: 2026-11-16 (origin/master 3b6e2d94; Okta behaviour against its documentation)
```

## Problem

Sign-in is Google only, in two hand-written paths. A second IdP must not merge accounts by email or leave a path Google-only by accident.

Facts in the code that shape it:

- **Three surfaces sign a person in**: the CLI's `/api/auth/exchange` (`authExchange`), the AS's `/oauth/google/callback`, and `/api/auth/dev-login`. The AS has no dev sign-in: under dev auth it still redirects upstream, and tests inject the exchange. Slack linking compares emails for an already signed-in user; it isn't a sign-in.
- **The two Google paths verify differently.** The AS sends a nonce and re-checks the email's domain after the exchange (`oauth.ts` callback, `oauth.domain_refused`). The CLI builds the authorize URL itself (`src/cli/oauth_flow.ts`), so its exchange has no nonce and trusts `hd` alone. `hd` is the Workspace's primary domain; the email is the bus address.
- **Google needs two client registrations**: a Desktop client for the CLI's loopback redirect and a Web client for the AS's callback (`mcpGoogle`).
- **`users.idp_subject` is a bare Google `sub`**, unique across all users (`idx_users_idp_subject`); `users.signIn` looks it up first.
- **A row with no subject takes the first sign-in that carries its email** (`linked`). Such rows are users from before F-13 and dev-login users; `teamAdd` refuses an email that never signed in, so nothing else makes one.
- **The injected `exchangeGoogle` returns an identity**, so every test that uses it skips token verification.
- **Upstream flow state is process memory** (`flows`, `upstream`), with one callback path, one pinned `iss` and Google's callback parameter list.
- **Audit actions are a closed union** (`src/server/audit.ts`), three of them named `oauth.google_*`.

## Decisions

### D1. The provider seam

`src/server/idp.ts` holds the types, the provider list built from config, and `idpSignIn` (today's `googleSignIn`).

```ts
type UpstreamIdentity = { issuer: string; subject: string; email: string; displayName: string | null };
type IdentityProvider = {
  id: string;        // "google", "okta": config, callback path, audit detail
  label: string;     // the chooser's link text
  issuer: string;    // half of the stored key: a constant, never a token's `iss`
  callbackParams: readonly string[];
  authorizeUrl(i: { redirectUri: string; state: string; nonce: string; challenge: string }): Promise<string>;
  exchange(i: { code: string; verifier: string; redirectUri: string; nonce: string }): Promise<UpstreamIdentity>;
};
```

- **Verification is inside `exchange`.** It returns only after signature, issuer, audience, expiry, nonce, verified email and email domain (D5) all held, with the email lowercased. A separate "verify" would let a caller skip it. `isValidEmail`, the disabled check and the sign-in transaction stay in the callers.
- **`authorizeUrl` is async** because an OIDC provider may need discovery first (D2).
- **`oauth.ts` keeps what is not provider-specific**: upstream state, PKCE verifier, nonce, the binding cookie, `routeName` and the callback parameter allowlist (both derived from the provider list), and the rule that a callback's `iss` parameter, when present, equals `provider.issuer` before any state is consumed.
- **Google is `src/server/idp_google.ts`**: today's `verifyGoogleIdToken` and `exchangeGoogleCode` moved unchanged, the same authorize parameters (`hd` included), `issuer` the constant `https://accounts.google.com` whichever of `GOOGLE_ISSUERS`' two spellings the token carried, or one `sub` would key two ways.
- **`OAuthOptions.exchangeGoogle` becomes `OAuthOptions.providers`**, the same trusted injection. No alias for the old name (principle 12). Its call sites move to one `stubProvider(identity)` in `tests/support/`.

### D2. The OIDC provider, which Okta configures

`src/server/idp_oidc.ts` is generic OpenID Connect; Okta is its configuration (`id: "okta"`).

- **Discovery is lazy.** `<issuer>/.well-known/openid-configuration` is fetched on first use, cached an hour, a failure retried after 30 s, in-flight fetches coalesced. Never at startup: a restart during an IdP outage would otherwise take down every user's existing tokens and the other provider's sign-ins.
- **Discovery checks**: its `issuer` equals the configured string exactly (no URL normalizing, as for the AS's own issuer); every endpoint is `https:` (or loopback `http:` under the tests' `allowLoopbackHttp`, D6); `S256` is offered.
- **The provider's own fetches** (discovery, token, userinfo) refuse redirects, time out at 10 s and bound the body. The JWKS fetch is `jose`'s: its 5 s timeout covers the headers only and the body is read unbounded, which is accepted because the URL comes from the operator's issuer.
- **JWKS through `jose`'s `createRemoteJWKSet`** (already a dependency, for Google's keys) with its defaults. An unknown `kid` refetches once per cooldown, so key rotation needs no code. An ID token reaches the verifier only from the token endpoint over TLS, so an outsider can't force refetches.
- **`jose`'s defaults are not safe ones** (`package.json` `^5.0.0`, `bun.lock` 5.10.0, read from that source): `jwtVerify`'s `clockTolerance` is 0 and `exp` is checked only when present, so the provider passes `requiredClaims` and a tolerance explicitly. `createRemoteJWKSet` caches 10 minutes and reloads for an unknown `kid` only when not cooling down (`RemoteJWKSet.getKey`): every sign-in whose token is signed by a key published within 30 s after the last JWKS fetch fails until the cooldown ends. Accepted: it is at most 30 s per rotation, a few times a year.
- **No new dependency and no `jose` major bump here** (the lock holds 5.x; the registry is on 6.x). The bump is its own PR. Rejected: `openid-client`, a second dependency for about 150 lines of discovery and exchange.
- **ID-token checks** (`jwtVerify`): `issuer` exact; `audience` the client ID, with Google's `azp` rules; `algorithms` pinned to an asymmetric allowlist intersected with what discovery offers, never `none` or `HS*` (an HS256 token keyed by the client secret is the classic confusion); `requiredClaims` `exp`, `iat`, `sub`; a 60 s clock tolerance and a 10-minute `maxTokenAge` (the token is seconds old); nonce required, not optional as `verifyGoogleIdToken`'s is today; `sub` a nonempty string of bounded length, stored verbatim.
- **Client authentication is `client_secret_basic`** with the ID and secret form-encoded before base64 (RFC 6749, section 2.3.1), plus PKCE. `private_key_jwt` waits for a caller (#126).
- **Claims**: scope `openid email profile`; `sub`, `email`, `email_verified`, `name`. When the ID token lacks `email` or `email_verified`, the provider reads `userinfo` with the access token; userinfo's `sub` must equal the ID token's (OIDC Core, section 5.3.2), and `email` and `email_verified` come from the same document, never one from each. `email_verified` other than `true` is refused. For Okta this is the normal path: in the code flow its ID token carries `email` at most, and `email_verified` only comes from `userinfo`. Okta signs with RS256 only.

### D3. Identity is keyed by issuer and subject

- **A new column `users.idp_issuer TEXT`**, added by a guarded `ALTER` in the schema step, beside `idp_subject`.
- **Subjectless old rows are stamped once, with the `ALTER`**: inside the same `if (column is missing)` guard and the same `BEGIN IMMEDIATE`, `UPDATE users SET idp_issuer = 'https://accounts.google.com'` for every row. Every existing subject is Google's, and every subjectless row's email was last proven by Google (or by dev login, on a dev database). This stamp must not run on a later open: it would re-stamp a row `unlink-idp` cleared.
- **A subject with no issuer is repaired on every open**: `UPDATE users SET idp_issuer = 'https://accounts.google.com' WHERE idp_issuer IS NULL AND idp_subject IS NOT NULL`, in the schema step. The documented rollback (`docs/guide/server.md`, the previous binary on the same database) lets the old binary create or link users with a subject and no issuer; without the repair the new binary would refuse them as `issuer_mismatch`. Only an old binary writes that shape, and an old binary only knows Google. A cleared row has neither column, so the repair never touches it.
- **Three row states**: issuer and subject (linked); issuer only (a pre-F-13 row, reserved for that issuer, D4); neither (dev login, or unlinked).
- **Uniqueness**: `CREATE UNIQUE INDEX idx_users_idp_identity ON users(idp_issuer, idp_subject) WHERE idp_subject IS NOT NULL`, after the repair. `idx_users_idp_subject` is dropped on every open (`DROP INDEX IF EXISTS`, since a rolled-back binary recreates it) and its `CREATE` removed: a constraint that one `sub` is unique across issuers is false, and would turn a collision into a 500.
- **`signIn(issuer, subject, email, displayName)`** stays one store method in one write transaction. On Postgres (postgres-server.md) the unique constraints (`users.email`, the index above) are the guarantee, not the reads before the write.
- **Linking is a conditional write.** Branches 4 and 5 of D4 link with `UPDATE ... WHERE id = ? AND idp_subject IS NULL AND (idp_issuer IS NULL OR idp_issuer = ?)` and check the row count; zero rows means another sign-in linked the row first, and the method re-reads and decides again (now `issuer_mismatch` or `subject_mismatch`). On Postgres two sign-ins from different IdPs would otherwise both pass the read and both update, with no constraint firing.
- **Every users write runs inside `repo.write`** (the server's write queue, #807), after the exchange's await; no provider touches `Repo`, and a write outside the queue will be refused. `authExchange` does the sign-in, session and audit in one body. The AS callback uses two bodies (sign-in, then the browser session) and writes `oauth.google_authenticated` outside both; step 1 leaves that as it is.
- Rejected:
  - *A namespaced value in `idp_subject`* (`<issuer>|<sub>`): either bare values mean Google forever, and the reader that forgets the rule matches across issuers, or old values are rewritten, and a rolled-back binary then refuses every user as `subject_mismatch`.
  - *Null issuer read as Google, no stamp*: the same hazard in every query.
  - *Keying on the provider ID*: `okta` can be repointed at another org by config; the issuer can't.
  - *A `user_identities` table* (several IdP accounts per user): linking is refused (D4), so nothing would hold a second row (open question 3).

### D4. Linking across IdPs

`signIn` in order:

1. A row with this (issuer, subject): `ok`, or `email_changed` when its email differs (unchanged).
2. A row with this email and a subject under the same issuer: `subject_mismatch` (unchanged).
3. A row with this email and another issuer, with or without a subject: `issuer_mismatch`, refused 403. This is the issue's default: an email another IdP's account holds never signs into that account, so criterion 4 holds for pre-F-13 rows too.
4. A row with this email, this issuer, no subject: linked (today's pre-F-13 rule, now only for the IdP that made the row).
5. A row with this email and neither: linked, issuer and subject both set.
6. No row: created with both.

- **Why 3 covers subjectless rows.** Today's "first sign-in with the email takes it" was safe with one IdP asserting the email both times. With two, it is exactly the merge by email the issue forbids.
- **The admin's remedy is the existing verb.** `grayboard admin unlink-idp --email <e>` clears issuer and subject; the next verified sign-in with that email from any enabled provider takes the account. An org moves a user from Google to Okta the same way. The refusal text names the provider that holds the email and that command, as `googleSignIn`'s do.
- A disabled row is still returned unbound for the caller to refuse (F-13), and a service row (#270) is refused before any of this.
- Rejected: auto-link when both IdPs report the email verified (two IdPs agreeing on an email is not one person; principle 8).

### D5. Org scoping is per provider, and includes the email's domain

- **Google is unchanged**: `hd` equals `GRAYBOARD_ORG_DOMAIN` and the email's domain equals it.
- **Okta's issuer and audience say only "assigned to this app in this org".** They say nothing about the email, which is a profile attribute in the IdP and the address every DM and alias hangs on. So the Okta provider takes a required list of allowed email domains and refuses any other (`oauth.domain_refused`). The issue text says the issuer already scopes to the org; for the address space it doesn't. This list, not `email_verified`, is the gate: what Okta's flag means for directory-sourced users is undocumented (open question 1).
- The list may repeat Google's domain: the pilot's two halves likely share one. D4 decides who holds an email; the first verified sign-in claims it (risk R2).
- The check lives in the provider (D1). Step 1 leaves the callback's domain check where it is; it moves into the Google provider when the CLI's own exchange is deleted (step 3), so no step changes what the CLI's path accepts while that path exists.

### D6. Config

- **`GRAYBOARD_IDPS`**, a comma list of provider IDs, default `google`: an existing deployment's env is unchanged. Known IDs are `google` and `okta`. The order is the chooser's.
- **Okta takes four variables**, all required when it is listed: issuer, client ID, client secret, allowed domains (`GRAYBOARD_OKTA_*`). Flat variables, not a JSON list like `GRAYBOARD_OAUTH_CLIENTS`: a secret in its own variable maps to one Kubernetes secret key, and a server has one org (`../vision.md` §1), so one Okta org.
- **Google's variables and `GRAYBOARD_ORG_DOMAIN` are required only when `google` is listed.** Through step 2 both pairs mean what they do today. From step 3 the AS's selection is the only one (`GRAYBOARD_MCP_GOOGLE_*` when set, else `GOOGLE_OAUTH_CLIENT_*`), and `GOOGLE_OAUTH_CLIENT_*` is required only when the MCP pair is absent: a deployment with a Desktop primary pair and a Web MCP pair changes nothing and its Desktop pair goes unused.
- **Startup refuses**: an unknown, repeated or empty list (dev auth aside); a listed provider missing a variable; an Okta variable set while `okta` isn't listed (a half-configured provider is a typo, as `mcpGoogleConfig` treats half a pair); an issuer that isn't `https:`, has a query, fragment or trailing slash, or equals Google's; a malformed domain; dev auth together with any provider's client secret (today's rule, widened).
- **No loopback exemption in config.** An `http:` public URL needs dev auth (`oauthPublicUrl`), and dev auth refuses any client secret, so a compiled server could never be started against a fake issuer anyway. The exemption is a constructor option of the OIDC provider (`allowLoopbackHttp`) that only tests set (D10); `loadConfig` always requires `https:`.
- **Not checked at startup**: that the issuer answers (D2).
- `/api/auth/config` is deleted with the CLI's direct flow (D8); nothing else lists providers.

### D7. The authorize choice and the callbacks

- **One provider: `/oauth/authorize` redirects upstream at once**, as today.
- **Several, and no browser session: it answers a chooser page** (the same `html()` helper and CSP as consent), one link per provider to `/oauth/upstream?request=<id>&provider=<id>`. That route finds the flow through the binding cookie (`getFlow`), creates the upstream state, verifier and nonce there rather than at authorize, and redirects. Choosing again replaces the flow's upstream state and drops the old one from `upstream`.
- **Each provider has its own callback, `/oauth/<id>/callback`**, and `f.upstream` records the provider. A callback whose path names another provider than the flow's is refused before the exchange. Separate redirect URIs plus provider-bound state are the mix-up defence; the callback's optional `iss` (D1) is not relied on: Okta's discovery doesn't advertise it.
- `/oauth/google/callback` keeps its path: it is registered at Google in every deployment.
- **The browser session stays provider-agnostic**: it names a user, and a live one skips upstream for any client, as today.

### D8. CLI login goes through the server's AS

`grayboard login` becomes one more client of the AS, for every provider, and the direct flow (`runOAuthFlow` against Google, `authExchange`, `authConfig`) is deleted.

- **Why not the direct flow per provider** (the CLI opens the IdP itself from a server-supplied template):
  - Okta compares redirect URIs as exact strings and allows no port wildcard, so a loopback listener would need fixed registered ports; the AS already takes ephemeral loopback ports for its own clients.
  - It needs a second app registration per provider (Google's Desktop client today).
  - The client builds the authorize URL, so there is no nonce, and provider logic ships in a binary that updates separately from the server.
  - Two paths means two sets of checks: today's CLI path already lacks the AS's email-domain check.
- **A client `grayboard-cli`, not a `BUILTINS` row** (`src/server/oauth-config.ts`): a `BUILTINS` row gets both scopes, refresh and `sourceKeyFor`'s generic key. It is its own constant: public, the same loopback redirects, PKCE, `allowRefresh: false`, scopes exactly `[LOGIN_SCOPE]`, no source key and no harness. Its ID is reserved as the built-ins' are (operator config can't reuse it; grants issued under it before are revoked at startup).
- **`LOGIN_SCOPE` (`grayboard:login`) is its own constant, never a member of `OAUTH_SCOPES`.** That list is what every built-in, every CIMD client (`oauth-cimd.ts`), operator validation, `scopes_supported` and the 401 hint are drawn from; adding the scope there would grant it to all of them. The one change is in `scopes()` (`oauth.ts`), which accepts a requested scope that is in `OAUTH_SCOPES` or is `LOGIN_SCOPE`; the existing per-client check (`client.scopes.includes`) then refuses it for every client but `grayboard-cli`. A request mixing it with another scope is refused.
- **The token endpoint answers a `grayboard:login` code with a CLI session**, not an OAuth grant: one store method consumes the code and calls `sessions.create` in one transaction, and the response's `access_token` is the `gbrd_v1_` token, with no refresh token and no expiry. The credentials file and `verifySessionToken` don't change. The code's client, redirect and verifier checks and `activeUser` are `redeemCode`'s.
- **A login code is marked consumed by a new nullable column `oauth_codes.session_id`** (guarded `ALTER`, beside `grant_id`), set in that transaction. `redeemCode`'s replay detection is `grant_id`, a foreign key to grants that a session can't fill. A login code presented again with `session_id` set revokes that session and audits `oauth.code_replay_revoked`, as a replayed grant code revokes its grant.
- **For the user**: the consent page appears in CLI login (one click); it stops a local process riding a live browser session silently.
- **For the operator**: a Google deployment whose only client is a Desktop one must add a Web client with the AS callback. Every deployment that serves agents already has one (hosted MCP needs it). The Desktop client and `GRAYBOARD_MCP_GOOGLE_*` stop being a second pair: the AS's selected pair is the only one. The release that carries step 3 gets a release note.
- **Old CLIs** can't sign in to a newer server until `grayboard update`; existing tokens keep working. No shim (principle 12).
- `docs/server-oauth.md` §1 says "CLI and API token authentication stays independent". The CLI's token still is; its sign-in becomes the AS's, and step 3 rewrites that sentence.
- Dev login is untouched.
- Rejected: OAuth access tokens on `/api/*` (the CLI would need refresh, a new credentials format and an audience for the API: a redesign of CLI tokens, not an IdP); a second, consent-less upstream leg just for the CLI (a second authorization server).

### D9. Audit

- `auth.subject_linked`, `auth.subject_refused` and `auth.subject_cleared` keep their names; each detail gains `provider` and `issuer`, and `auth.subject_refused` gains the reason `issuer_mismatch` with the holding issuer.
- `oauth.google_denied`, `oauth.google_failed` and `oauth.google_authenticated` become `oauth.upstream_*` with `{provider}`: the union is closed, so a per-provider name can't be. Old rows age out at the audit retention; nothing maps them (principle 12).

### D10. Testing

- **`tests/support/fake_oidc.ts`, `startFakeOidc()`**, in the pattern of `startFakeAnthropic()`: a loopback server with discovery, JWKS, an authorize endpoint that redirects back with a code, a token endpoint that checks client authentication, the code's one use and the PKCE verifier, and userinfo.
- **Bad tokens are minted, not stubbed**: a `next({...})` knob for the next ID token (another key's signature, `iss`, `aud`, `exp`, `iat`, `nonce`, `alg`, `kid`, `email_verified`, no `email`), a discovery document override, and `rotateKeys()`.
- **Criterion 3 runs the real provider over HTTP** against the fake (`src/server/idp_oidc.test.ts`, the provider built with `allowLoopbackHttp`): bad signature, wrong issuer, wrong audience, expired, each its own test; plus wrong nonce, HS256 keyed by the client secret, unverified email, a domain off the list, discovery naming another issuer, userinfo with another `sub`. Key rotation, with the provider's `cooldownDuration` passed through and set to 0: a rotated key is accepted after one refetch; with the default, it is refused inside the cooldown.
- **Criterion 1**: `tests/integration/oidc_login.test.ts` drives `hostedServer()` (in process, dev auth on, as every hosted test) with `OAuthOptions.providers` holding the real OIDC provider, `allowLoopbackHttp`, aimed at the fake: injection replaces only how the provider is built, not what it does. `browse()` follows the upstream redirect instead of assuming a stub; a hosted MCP call with the resulting token works. With two providers, the chooser appears and each link reaches its IdP. No test starts a compiled server with Okta (D6); the gap, config to provider, is a unit test of the function that builds the list from `Config`.
- **Criterion 2**: steps 1 and 2 change `oauth.test.ts` and the hosted suites only where they name `exchangeGoogle`. **Step 3 departs from "Google sign-in is unchanged"** for the CLI: an old CLI can't sign in, CLI login gains a consent click, and the `/api/auth/exchange` and `/api/auth/config` tests are deleted with their routes. That is principle 12 (no shims, no deprecation window), and the issue's criterion is amended to say AS sign-in is unchanged.
- **Criterion 4**: `db.test.ts` for each D4 branch; one integration test both ways round (Google holds the email and Okta presents it; the reverse), asserting 403, no browser session, an `auth.subject_refused` row, and that `unlink-idp` then lets the second IdP in. Also: the same `sub` under two issuers is two users. Fixture rows are seeded through `tests/support/seed.ts` once #807's fixtures move there.
- **Upgrade**: `tests/integration/upgrade.test.ts` and the upgrade matrix open release databases; add asserts that a v1.0.0 database (no `idp_subject`) and a post-F-13 one both come out stamped, and that a second open doesn't re-stamp a cleared row. A round trip: open under HEAD, then let the latest release's binary sign a user in and recreate its index, then open under HEAD again; that user has Google's issuer, the old index is gone and they sign in.
- **Config**: `config.test.ts`, one case per refusal in D6. **CLI**: a `runCli()` login against `hostedServer()`, and a test that no other client can obtain `grayboard:login` (R3).
- **Suites**: all of it is the root suite (`bun run test`). No e2e suite calls a real Okta; `hosted-live` and `hosted-public` stay on Google.

## Docs to update when built

- `docs/architecture.md` §3 (the Login bullet): the provider seam, identity keying and linking, the "Google tokens are never stored" invariant reworded for any IdP, the CLI's sign-in through the AS.
- `docs/server-oauth.md` §1: the upstream leg (per-provider callback, chooser, `iss` rule), the single Google pair; §2: the `grayboard-cli` client and the login scope.
- `docs/guide/server.md`: an Okta setup section (a Web app with PKCE required, its exact callback, the four variables), the one-Google-client setup, `unlink-idp`'s wording; `docs/guide/team.md`, `harnesses.md`, `reference.md` and `troubleshooting.md` where they say Google, and `README.md`'s "Google sign-in" lines. `install.sh`'s closing hint names the Google variables.
- `docs/parity.md` row 9 (sign-in flow): no cell changes, since the provider is the server's and every hosted harness reaches the chooser in the same browser leg; local cells stay n/a. `docs/parity-access.md` §9 gains one line saying so.
- `role-bindings.md` R1 and `service-principals.md` cite #928's keying.

## Sequence

Each step merges green on its own.

1. **Seam, Google only, no behaviour change.** `idp.ts`, `idp_google.ts`, `OAuthOptions.providers`, `stubProvider`; `oauth.ts` calls the provider. Paths, audit names and config untouched. `authExchange` can't call `IdentityProvider` as typed: it uses the primary client pair where the AS uses its selected one, sends no nonce and has no email-domain check. So `idp_google.ts` also exports a CLI-flavoured exchange (primary pair, no nonce, `hd` only: today's call) that `authExchange` uses until step 3 deletes both. `exchangeGoogle` call sites outside the root typecheck move too: `adapters/opencode-v2/tests/host.ts` and `real-server.ts` (`bun run test:opencode`) and `tests/e2e/opencode-config.ts`.
2. **Identity keying.** `idp_issuer`, the stamp, the index swap, `signIn`'s new signature and `issuer_mismatch`, `unlink-idp` clearing both, the audit detail.
3. **CLI login through the AS** (D8), Google only: `grayboard-cli`, `LOGIN_SCOPE`, `oauth_codes.session_id` and the session redemption, the direct flow, the CLI-flavoured exchange and `/api/auth/config` deleted, the domain check moved into the provider, nonce made required. Release note.
4. **The OIDC provider and the fake issuer** (D2, D10's unit tests). Test-only callers for one PR.
5. **Okta enabled**: config (D6), per-provider callbacks and the chooser (D7), the audit rename (D9), the integration tests, the guide. Deletes this file.

Steps 1 to 3 need no Okta; 3 can follow 5 only if no release is cut between, or an Okta deployment ships with no CLI login.

## Open questions, with defaults

1. Is Okta's `email_verified` `true` for every user the pilot has (directory-sourced, federated)? Okta's documentation doesn't say. Default: require `true`, no bypass flag; an operator whose org doesn't assert it fixes that at the IdP. Check with the pilot's org before step 5.
2. May an admin pin which provider takes an unlinked account (`unlink-idp --provider`)? Default: no; both IdPs are the operator's, and the admin tells the person which to use.
3. One person with both a Google and an Okta account? Default: no; one identity per user until someone needs a `user_identities` table.
4. What is the CLI's code bound to? `/oauth/authorize` accepts only the MCP resource. Default: the CLI omits `resource`, the scope alone selects the session redemption, and the minted token is no more audience-bound than today's. Alternative: a second resource identifier for `/api`, requestable only by `grayboard-cli`.

## Risks

- **R1. Rollback below step 2.** An older binary reads `idp_subject` alone, writes no issuer and recreates the global index. While every subject is Google's, a round trip is repaired on the next open (D3). Once Okta users exist it is unsupported: the old binary can't sign them in, would match a row by `sub` alone, and fails to start if two issuers share a `sub`.
- **R2. Squatting inside a shared domain.** An IdP that lets a user's email be set to a colleague's who has never signed in claims that address first. D4 protects existing rows only. Mitigations are the operator's: verified emails at the IdP, or disjoint domains.
- **R3. `grayboard:login` is a session-minting scope on the AS.** If any other client could request it, consent phishing would yield a CLI token. D8's rule (a constant outside `OAUTH_SCOPES`, held only by `grayboard-cli`'s scope list) is the invariant its tests must pin: a built-in, a CIMD client and an operator client each asking for it are refused `invalid_scope`.
