#!/usr/bin/env bash
# Runs a compile command with a private scratch directory as its cwd.
#
# bun build --compile stages its output as a .<hash>-00000000.bun-build file in
# the process's working directory and renames it into place. When the running
# bun binary is not writable (mode 555, as Homebrew installs it), the stage
# file survives a successful build: ~60 MB of read-only litter per compile.
# Upstream: oven-sh/bun#14020, fix in review: oven-sh/bun#46624. Until a bun
# with the fix is pinned, every compiled build in this repo runs through this
# wrapper: the command executes with a fresh temp dir as its cwd, so the stage
# file lands there and is removed with the directory — never in the repo,
# where a pattern sweep could unlink a concurrent build's stage file.
#
# Paths in the command (entry point, --outfile) must be absolute, since the
# command runs from the scratch directory.
#
# Usage: build_scratch.sh <command> [args...]
set -eu
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
"$@"
