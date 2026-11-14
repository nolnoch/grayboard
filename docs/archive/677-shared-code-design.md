> Archived design (2026-11-14). Shared subtasks (#636, #679) were reverted before release: the factory stays a self-contained swarm, taking work in and handing results back, with no outside lanes on its queue. This branch's tip is master just before the revert; the draft below was never implemented. Revisit with the design issue for outside participation.

# #677 design: shared subtasks that carry code (worktree mode)

Status: proposal, nothing implemented. Grounded in `master` at `faf6818`: `adapters/factory/factory.ts` (`takeShared`, `finishShared`, `recoverShared`, `shareDue`, `res()` at line 446), `workdir.ts` (`Workspaces`), `main.ts` (`shareOf`), `fanout.ts` (`synthesisPrompt`), `store.ts` (`shareTake`, `shareFinish`).

## 0. What the code does today, and where the issue's wording is off

- **Nothing merges in code.** The issue (and the brief for this design) says the synthesis "merges it like a local subtask's worktree". There is no such merge: `Workspaces` only makes detached worktrees; the synthesis is an agent run in `<tree>/main` with `--add-dir <tree>`, told `Its files: ../<seq>`. It combines by reading siblings and editing `main`, or by `git merge <sha>` only when the profile grants `Bash` in both `tools` and `allowedTools` (the default is no shell). So the job is not "teach the factory to merge", it is "make an outside lane's commit appear as one more sibling directory".
- **A subtask's base commit is not recorded.** `Workspaces.worktree()` resolves it lazily at `place()` (main's `HEAD` then). A subtask an outside lane takes never gets a place, so there is nothing to check ancestry against, and nothing to tell the taker to start from. The base also moves every round (the review commits in `main`).
- **The outcome binding is synchronous.** `finishShared` is sync and `recoverShared` relies on the state flipping inside its loop. Verifying a commit is async git work, so the order of checks and the compare-and-swap must be spelled out (§4).
- **The factory is local-only** (`docs/factory.md` §2, #676 open). Every `shareWith` handle today is the operator's own OS user on the same machine, with the same filesystem. A network remote is not needed until the hosted head exists.

Threat model in one line: locally the checks guard against steered model output and mistakes, not a hostile user; signing, remotes and identity bite only under #676. The trust an accepted commit grants is "a local subtask's child with write tools in its worktree", no more.

## 1. Outcome format

- **Decision: the outcome carries only a commit, never a branch.** One line anywhere in the reply, alone on its line: `commit: <full sha>` or `commit: none`. Rationale: a taker-named branch is untrusted text turned into a refspec, and lets a reply point the fetch at any ref on the remote. The ref name is the factory's (§2); the sha is what the listed handle vouches for.
- **Parser:** `commitOf(body): { sha: string } | "none" | "ambiguous" | null`, beside `outcomeOf` (which is unchanged): `/^commit:[ \t]*([0-9a-f]{40}|[0-9a-f]{64}|none)[ \t]*$/gim`. Full ids only (no abbreviations: an abbreviation is resolved by the object store, so its meaning can change). Two lines naming different values is `ambiguous` and rejected. Parse from the full body, before `clip(body)`.
- **`done:` in a worktree-mode tree must carry the line.** A `done:` with no `commit:` line is not accepted: accepting it as text-only is exactly the bug #677 names (finished, but its code silently missing). `commit: none` is the explicit "I changed nothing" form and finishes text-only, as in scratch mode.
- **`failed:` needs no commit** and any `commit:` line on it is ignored (v1). Rationale: one rule fewer; a failed outside subtask's partial work is not worth a verification path.
- **Scratch-mode trees are unchanged**: no `commit:` line is asked for or read.
- **Which rule applies comes from the row, not the fleet's current mode**: a subtask row with a recorded `base` (below) follows the commit rules, so a config reload mid-tree changes nothing for trees in flight.

The subtask post's footer (`take` in `fanOut`) gains, for a worktree-mode sharing fleet: the base sha, where to get it, where the work must end up, and the `commit:` line. Stage A text: `This subtask's result is commits. Start from <base sha> in <repo path> (a worktree of it, or a clone: fetch <base ref>). Commit your work there, or push it to <repo path> as <result ref>. End your outcome with a line "commit: <full sha>", or "commit: none" if you changed nothing.`

## 2. Which remote, and how it is fetched

Two stages. Stage A ships now and has no fetch. Stage B is specified here but should land with or after #676.

| | A: the repo's own object store (no remote) | B: per-fleet `shareRemote` URL | `repo`'s `origin` by default |
|---|---|---|---|
| Who it serves | every lane that exists today (same machine, same user) | lanes on other machines (needs #676) | same as B |
| New attack surface | none (no network, no fetch) | fetch, credentials, a push of the base | same as B, plus the main remote |
| Config | none | one explicit key | none, implicit |
| Side effects | refs under `refs/factory/` in `repo` | branches on a remote the operator chose | task branches on the project's main remote: CI runs, branch clutter, every taker needs push rights there |

Recommendation: A now; B with an explicit `shareRemote` (a URL, no default); never default to `origin` (the operator may write origin's URL there deliberately).

**Outbound half (both stages): pin and publish the base.**
- At fan-out, for a worktree-mode sharing fleet: `base = git -C <tree>/main rev-parse --verify HEAD^{commit}`, stored on each subtask row (new column `base`), used for the taker's instructions, the ancestry check, and the local fallback's worktree (`Workspaces.worktree` takes the recorded base when the row has one, instead of main's `HEAD` at place time).
- The base is a detached, unreferenced commit, so a clone cannot fetch it. The factory publishes it: `git -C <repo> update-ref refs/factory/share/<fleet>/<request id>/r<round> <base>`. `<request id>` is the root's post id (known before the subtask posts exist; the subtask's own post id is not, so it cannot be in a name the post body states).
- Result ref the taker may push to (stage A, clones only): `refs/factory/share/<fleet>/<request id>/r<round>.<i>`. A taker in a worktree of `repo` pushes nothing: its commit is already in the store.
- Lifetime: the tree directory records `{repo, ref prefix}` (`<tree>/share.json`); `Workspaces.remove` deletes every ref under the prefix (`git for-each-ref --format='delete %(refname)' <prefix>/ | git update-ref --stdin`) before `worktree prune`. So the refs go with the tree, as its worktrees do.

**Stage A "fetch":** none. `git -C <repo> cat-file -e <sha>^{commit}`; absent is "unreachable" (§4).

**Stage B, exact commands.** `<url>` is the fleet's `shareRemote`; `<name>` is `<fleet>/<request id>/r<round>`. All run through `workdir.ts`'s `git()` (which strips inherited `GIT_*`), with env added explicitly: `GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_SSH_COMMAND="ssh -oBatchMode=yes"`, and a 120 s kill timer.

- Publish the base at fan-out (a failure fails the fan-out before anything is posted): `git -C <repo> -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always push --no-verify -- <url> <base>:refs/heads/factory-share/<name>`
- Fetch one outcome, only the factory-named branch, into a quarantine ref: `git -C <repo> -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always -c fetch.fsckObjects=true -c fetch.recurseSubmodules=false -c submodule.recurse=false -c credential.interactive=false fetch --no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance --refmap= -- <url> +refs/heads/factory-share/<name>.<i>:refs/factory/incoming/<name>.<i>`
- Then `git -C <repo> rev-parse --verify refs/factory/incoming/<name>.<i>^{commit}` must equal the claimed sha, else "unreachable: the branch isn't at that commit".
- The quarantine ref is deleted in a `finally` (`git update-ref -d`), accepted or not; an accepted commit is kept alive by its worktree's `HEAD` (§4).

Why these: the refspec is built from store values only (fleet name `[a-z0-9_-]`, numeric ids), nothing from the reply; `--refmap=` (empty) stops a URL that matches a configured remote from also updating its tracking refs; `--no-tags` stops tag auto-following; fetching the named branch and requiring tip == sha avoids fetch-by-sha, which depends on the server's `uploadpack.allow*SHA1InWant`; `protocol.allow=never` plus two allows shuts `ext::`, `file` and the rest (tests add `protocol.file.allow=always` for a bare temp remote, see §7). All flags and keys above were confirmed in git 2.53's help. git has no client-side cap on a fetch's size (no such option in `git fetch` or `transfer.*`), so size is bounded by the timer before and the checks in §3 after.

## 3. Trust model

- **Who may supply a commit:** only the reply that finishes the subtask, so only a `shareWith` handle (the existing `finishShared` check runs first; an unlisted handle's reply never reaches git). Binding the answer to the lane that took the claim stays deferred to #676, as #636 left it.
- **Ancestry:** `git merge-base --is-ancestor <base> <sha>` must succeed. Rationale: the commit then contains the tree's work so far and nothing from an unrelated history root; a wrong base is the commonest honest mistake.
- **Size** (constants in v1, config when someone hits one): `git rev-list --count <base>..<sha>` at most 200; `git rev-list --objects --disk-usage <base>..<sha>` at most 64 MiB; at most 2,000 changed paths. `git()` caps output at 1 MiB; overflowing it on the path listing counts as over the limit, not as an error.
- **Paths:** from `git diff-tree -r -z --no-renames --raw <base> <sha>`, refuse the commit when any changed entry is a gitlink (mode 160000) or a symlink (120000), or its path's basename is `.gitmodules`, `.gitattributes`, `.lfsconfig`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.md`, or any path component is `.claude`. Rationale: the outside reply reaches the synthesis fenced as data; these are the files a later agent or git itself reads as instructions or configuration rather than data (a symlink can aim a confined file tool outside the tree; attributes select the operator's configured filter and merge drivers). A subtask that must change one runs locally.
- **No general path allowlist.** A local child is not path-confined inside its worktree either; tree claims (#669) and `mirrorClaims` (#675) are the existing partitioning. Revisit under #676.
- **Signed commits: not required.** Locally a signature proves nothing the same-user bus handle does not. Hosted, the authority is the server-reported identity plus `shareWith`; requiring signatures adds a second identity system (an allowed-signers list per handle) for no extra binding, since the sha in an authenticated reply already names the exact content. Optional `shareSigners` can be a #676 follow-up.
- **Nothing executes during the factory's own git steps.** Fetch: flags in §2 (no hooks, no submodule recursion, fsck on receipt, no credential prompt, restricted protocols). Checkout of the accepted commit: `git -C <repo> -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false worktree add --detach <tree>/<seq>.in <sha>` with `GIT_LFS_SKIP_SMUDGE=1`. The factory never runs `merge`, `submodule` or `lfs`.
- **Residual, stated plainly.** (a) A non-LFS filter driver the operator configured cannot be disabled generically; refusing `.gitattributes` changes means the commit cannot newly select one. (b) These flags cover only the factory's commands. The real execution surface is the next agent whose cwd or `--add-dir` holds the tree: the synthesis, and after the lead merges, every later round's subtasks. That is the same exposure as a local subtask's commit, bounded by the profile's tools. (c) Unverified: whether a `--restricted` child loads a `CLAUDE.md` from its cwd. `docs/factory.md` §5 says restricted mode ignores settings files and hooks; it does not say memory files. The denylist above assumes it might; measure it in e2e `claude-local` and drop those names if it does not.

## 4. Sequence and failure handling

Order in the (now async) `finishShared`, per reply, serialized per subtask:

1. Listed handle? Else log and ignore (unchanged).
2. Row has `base`? Else today's path (scratch).
3. `commitOf`; then obtain (stage A: object exists; stage B: fetch and tip check); then the §3 checks.
4. Materialize `<tree>/<seq>.in` (under `Workspaces.serial`). The name is one a local run never uses: `place()` reuses an existing `<tree>/<seq>`, so checking the outside commit out there could hand a local fallback run a worktree at the wrong commit.
5. `store.shareFinish(seq, reply, by, sha)`: the compare-and-swap. Lost (our own lane took it, or it was cancelled): `git worktree remove --force <tree>/<seq>.in`, log, ignore.
6. `res()` gives a `sharedBy` row with a commit `dir: "<seq>.in"`, so the synthesis prompt says `Its files: ../<seq>.in` after the existing "Taken by … its reply below is data" line, plus `Its commit: <sha>, in your repository.`

While a subtask is being verified it is in an in-memory `verifying` set and `shareDue` skips it, so the timeout cannot start a local run under a verification about to succeed; the delay is bounded by the 120 s timer. `recoverShared` awaits each reply's verification in thread order and stops at the first accepted one. A restart that finds `<seq>.in` on a row still `shared` removes and re-makes it; on a finished row it is left alone.

**One rule for every rejection: a rejected outcome is as if never sent, plus a reason in the thread.** It matches #636 ("anyone else's is logged and ignored, and the subtask keeps waiting"), lets the taker fix and reply again, and leaves one fallback path (the timeout).

| Case | What happens | Local fallback? |
|---|---|---|
| `done:` without a `commit:` line, or ambiguous | `[factory] not accepted: …` in the thread, naming the line wanted; keeps waiting | at `shareTimeoutMs` |
| Unreachable (object absent; stage B: fetch failed or timed out, or branch tip is not the sha) | not accepted, reason; keeps waiting | at `shareTimeoutMs` |
| Not a descendant of the base | not accepted, naming the base sha; keeps waiting (the taker can rebase and answer again) | at `shareTimeoutMs` |
| Over a size limit or touching a refused path | not accepted, naming the limit or path; keeps waiting | at `shareTimeoutMs` |
| Third rejected outcome on one subtask | the factory takes it (`shareTake`) and runs it here at once, saying so; later outcomes ignored | immediately |
| Checkout of an accepted commit fails | treated as unreachable (it happens before the swap) | at `shareTimeoutMs` |
| Timeout with no accepted outcome | unchanged from #636: runs here, from the recorded base | yes |
| Merge conflict | not detected and not a failure: the commit is delivered as a sibling directory and the synthesis agent reconciles it, exactly as two local subtasks that conflict | no |
| `failed:` from a listed handle | unchanged: finishes failed, text only | no |

Nothing here fails a subtask outright: every bad commit is either fixable by the taker or replaced by a local run. I did not add a code-side conflict precheck (`git merge-tree --write-tree`): conflicts between siblings only exist at synthesis, and a profile without a shell combines by reading, not merging.

## 5. Shared mode: refuse

- `shared` runs every child in one directory "for read-only profiles" (`workdir.ts`): no per-subtask directory, no base commit, possibly not a git checkout, possibly dirty, possibly in use by other running children.
- Landing an outside commit there means the factory itself checking out or merging into the operator's live directory, which it never does for anything.
- Keep the config refusal, with a message that says why. Text-only sharing in shared mode (an outside lane's reply is worth as much as a read-only local subtask's) is a separable relaxation; file it as its own issue if wanted, not part of #677.

## 6. Config and validation (`adapters/factory/main.ts`)

- `shareOf` line 208: accept `scratch` and `worktree`; `shared` refused: `"share" needs "workdir" "scratch" or "worktree": a shared directory has no commit an outside lane's work could be checked against`.
- Stage A adds no key.
- Stage B: `shareRemote` on a fleet, string, only with `share: true` and worktree mode (else `needs …` errors in the existing style). Accept `https://…`, `ssh://…` or `user@host:path`; refuse a leading `-`, `::` (transport helpers), a password in userinfo, and whitespace. A reload that changes it applies to later fan-outs; a row keeps the remote its tree was posted with (store it in `share.json`).
- At start, when any fleet shares in worktree mode: `git --version` at least 2.31 (`rev-list --disk-usage`), else the start is refused naming the version.
- Store (`store.ts`): two columns by guarded `ALTER TABLE`, like `shared_until`: `base TEXT` (set in `fanOut`'s transaction) and `shared_commit TEXT` (set by `shareFinish`). `Fields`/`Row` gain `base`, `sharedCommit`.
- `Workspaces`: `publishBase`, `adopt(repo, tree, seq, base, sha)` (checks + `.in` worktree), `dropAdopted`, and the ref cleanup in `remove`. `git()` gains an optional extra env and timeout.

## 7. Test plan (`tests/integration/factory.test.ts`, existing helpers)

Real git in temp dirs, every test-side `git` with `repositoryGitEnv()`; `FakeBus` + a `FakeBus("factory-share", 3000)` poster; `loop({ fleets: [{ ...SHARE, workdir: { mode: "worktree", repo } }] })`; `until()` only, no sleeps.

- **config:** share + worktree loads; share + shared refused with the new message; stage B `shareRemote` cases in the existing table style.
- **`commitOf` unit:** sha-1 and sha-256 lengths, `none`, abbreviated (null), two different (ambiguous), the same twice (ok), inside a sentence (null), CRLF.
- **`Workspaces.adopt` unit:** descendant accepted and `<tree>/<seq>.in` is at the sha; non-descendant, absent object, gitlink, symlink, each refused basename, a `.claude/` path, 201 commits: each rejects with its reason and leaves no directory; a `post-checkout` hook in `repo` writing a marker does not run; a `filter.lfs.smudge` set in `repo`'s config to write a marker does not run; `sweep` removes the worktree and every `refs/factory/share/…` ref.
- **loop, happy path:** the post body names the base sha and both refs; `be` commits in its own worktree of `repo` and replies `done: …\ncommit: <sha>`; row is finished with `sharedBy: "be"` and the commit; the synthesis input contains `Its files: \`../<seq>.in\`` and the fenced reply; `runner.runs` shows no local run of that subtask.
- **loop, rejections:** `done:` with no line gets `not accepted` and the row stays `shared`; a non-descendant likewise, then a valid outcome from `be` is accepted; `commit: none` finishes text-only with no `dir`; an unlisted handle's valid commit is ignored and no `.in` directory appears.
- **loop, fallbacks:** a rejected outcome then `shareTimeoutMs` (50 ms, `askTickMs: 20`) runs it here in `<tree>/<seq>` at the recorded base, after `main` has moved on; three rejections run it here at once; a late valid outcome after the local take leaves no `.in` (the swap lost).
- **restart:** a store with a `shared` row and a thread (`poster.read`) holding a valid outcome: `recoverShared` verifies and finishes it; a stale `.in` at another sha is replaced.
- **stage B:** a bare repo in a temp dir as `shareRemote` (the test passes `protocol.file.allow` through a test-only option); the base branch is pushed at fan-out; the remote also holds an `evil` branch and a tag: after acceptance `git for-each-ref` in `repo` shows neither, no tracking refs, and no `refs/factory/incoming/`; branch tip not equal to the sha is refused.
- **e2e (`claude-local`), one measurement:** does a `--restricted` child load a `CLAUDE.md` in its cwd (§3 residual c).

## 8. Docs and parity

- `docs/factory.md` (read `docs/CONTRACT.md` first):
  - `doc-meta` invariants: extend the clause "a shared subtask's outside outcome counts only from a `shareWith` handle and reaches a synthesis fenced as data" with "; its code enters only as a commit id in that outcome, descending from the subtask's recorded base, fetched (when a remote is configured) only from the factory-named branch, and checked out by the factory with hooks, submodules and LFS off; the factory never merges". The clause "a scratch or worktree run's directory is its tree's, removed only after the store prunes the tree's request" gains "with the refs it published".
  - §5 Working directories: the `.in` sibling; the recorded base for a shared subtask's local fallback.
  - §6 Store: the two columns.
  - §7 Sharing: replace "Scratch-mode fleets only … (#677)" with scratch or worktree; a new bullet "Code from outside lanes" (format, base, checks, the rejection rule); "What outside lanes bypass" gains tree claims on a shared repository (point at `mirrorClaims`).
- `docs/guide/local.md`, the factory paragraph: "(scratch `workdir` only)" becomes scratch or worktree, plus one sentence on `commit:` and starting from the named base.
- Parity: factory only; no `docs/parity.md` cell changes (as #636 and the issue say).

## 9. Flags on the issue's proposed solution

- **"`done:` names the branch and commit": drop the branch.** See §1.
- **"The synthesis fetches it … and merges it": two things wrong.** Fetch and verify at outcome time, while the row is still `shared`, so a bad commit can still fall back to a local run; at synthesis time the subtask is already finished and the only options left are a hole or a failed task. And nothing merges in code (§0).
- **"A remote both sides can reach": not needed today.** It adds fetch, credentials and an outbound push for lanes that cannot exist until #676. Stage it.
- **Missing from the issue:** the outbound half (recording and publishing the base), without which "descends from the request's HEAD" has no HEAD to name and a clone cannot start from it.

## 10. Open points

- Whether stage B should be designed in the #676 PR instead of specified here: its outbound push sends planning-run commits to a shared remote, which #676's outbound-content switch should gate.
- The path denylist may be too strict for repos where `AGENTS.md` or `.gitattributes` are routine edits (such subtasks silently become local runs at the timeout). The e2e measurement decides the memory-file names; `.gitattributes` is a judgement call.
- Publishing refs under `refs/factory/` in the operator's `repo`: invisible to `git branch`, but visible to `git for-each-ref` and to mirrors that push `refs/*`.
- The cap of three rejected outcomes and the size constants are guesses.
