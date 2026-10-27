#!/usr/bin/env bash
set -euo pipefail
# Resolve the latest published release, never a branch or an annotated tag object.
tag="$(gh release view --repo nolnoch/grayboard --json tagName --jq .tagName)"
[[ "$tag" =~ ^v[0-9][a-zA-Z0-9.+-]*$ ]] || { echo 'Invalid latest release tag' >&2; exit 1; }
refs="$(git ls-remote https://github.com/nolnoch/grayboard.git "refs/tags/$tag" "refs/tags/$tag^{}")"
revision="$(printf '%s\n' "$refs" | awk -v tag="refs/tags/$tag" '$2 == tag {direct=$1} $2 == tag "^{}" {peeled=$1} END {print peeled ? peeled : direct}')"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Latest release has no resolvable commit' >&2; exit 1; }
printf '%s\n' "$revision"
