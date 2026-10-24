#!/usr/bin/env bash
# Runs a build command, then sweeps bun's --compile scratch files from the cwd.
#
# bun build --compile stages its output as a .<hash>-00000000.bun-build file in
# the working directory and renames it into place. When the running bun binary
# is not writable (mode 555, as Homebrew installs it), the stage file survives
# a successful build: ~60 MB of read-only litter per compile. Upstream:
# oven-sh/bun#14020, fix in review: oven-sh/bun#46624. Until a bun with the
# fix is pinned, every compiled build in this repo goes through this wrapper.
#
# Usage: build_sweep.sh <command> [args...]
set -u
"$@"
status=$?
find . -maxdepth 1 -type f -name '.*.bun-build' -delete
exit $status
