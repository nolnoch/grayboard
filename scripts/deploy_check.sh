#!/usr/bin/env bash
# Check a live grayboard server from outside its host: fails unless /healthz
# answers ok and reports the given release.
#   scripts/deploy_check.sh https://grayboard.example.com v1.11.0
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <server url> <tag>" >&2
  exit 2
fi
url="${1%/}/healthz"
want="${2#v}"

resp="$(curl -sSL --max-time 10 -w '\n%{http_code}' "$url")" || { echo "deploy_check: no healthy answer from ${url}" >&2; exit 1; }
status="${resp##*$'\n'}"
body="${resp%$'\n'*}"
# The server refuses every request from an address it's limiting after
# repeated authentication failures (#240), /healthz included.
if [ "$status" = 429 ]; then
  echo "deploy_check: ${url} is rate-limiting this address (${body}); run it from another address, or after the wait" >&2
  exit 1
fi
if [ "$status" != 200 ]; then
  echo "deploy_check: no healthy answer from ${url} (HTTP ${status}: ${body})" >&2
  exit 1
fi
got="$(printf '%s' "$body" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
case "$body" in *'"ok":true'*) ok=1 ;; *) ok=0 ;; esac
if [ "$ok" != 1 ] || [ "$got" != "$want" ]; then
  echo "deploy_check: ${url} reports ${body}, not ok with version ${want}" >&2
  exit 1
fi
echo "deploy_check: ${url} is ok and reports ${got}"
