#!/usr/bin/env bash
# grayboard installer — downloads release binaries and drops them into a bin dir.
# The release's SHA256SUMS must carry a signature from a key listed below and
# name the release's tag; every binary must match both its SHA256SUMS line and
# the digest the release API publishes, and the CLI must report the tag. Only
# then is anything installed; any missing or failed check refuses (#162, #173).
# Requires openssl.
#
# Default install (developer machine):
#   curl -sSL https://github.com/nolnoch/grayboard/releases/latest/download/install.sh | bash
#   → installs `grayboard` to ~/.local/bin, then runs `grayboard setup`
#
# Server install (one-deployment-per-org):
#   curl -sSL https://github.com/nolnoch/grayboard/releases/latest/download/install.sh \
#     | sudo INSTALL_SERVER=1 INSTALL_DIR=/usr/local/bin bash
#   → also installs `grayboard-server`, the release's deploy files (the systemd unit,
#     the Caddyfile, and `grayboard-backup` beside the binaries; each verified against
#     the signed SHA256SUMS like the binaries), then, if the grayboard systemd unit
#     runs that binary, restarts it and waits for /healthz to report the installed release
#
# Overrides:
#   GRAYBOARD_VERSION=v2.0.0   pin a release (default: latest); a release
#                              published before signing has no SHA256SUMS and
#                              needs its own install.sh
#   INSTALL_DIR=/some/path     install dir   (default: ~/.local/bin)
#   GRAYBOARD_REPO=fork/repo   alternate repo
#   GRAYBOARD_RELEASES_URL=https://mirror.example.com
#                              serves github.com's release paths instead of github.com
#   INSTALL_SERVER=1           also fetch grayboard-server and the deploy files
#   GRAYBOARD_NO_DEPLOY=1      with INSTALL_SERVER=1, skip the deploy files
#   GRAYBOARD_DEPLOY_REPLACE=1 replace a unit or Caddyfile that differs from the release's
#                              (default: keep it and say so); the old one is kept as <file>.prev
#   GRAYBOARD_UNIT_DIR=/dir    where the unit goes   (default: /etc/systemd/system)
#   GRAYBOARD_CADDYFILE=/path  where the Caddyfile goes (default: /etc/caddy/Caddyfile)
#   GRAYBOARD_NO_SETUP=1       skip `grayboard setup`

set -euo pipefail

# A stalled origin fails the install instead of hanging it: 30 s to connect,
# and under 1 KB/s for 60 s aborts a transfer.
CURL_LIMITS=(--connect-timeout 30 --speed-limit 1024 --speed-time 60)

if ! command -v openssl >/dev/null 2>&1; then
  echo "grayboard: openssl is required to verify the release's signature; install it (apt install openssl, dnf install openssl) and rerun" >&2
  exit 1
fi

REPO="${GRAYBOARD_REPO:-nolnoch/grayboard}"
# One origin for every download, without trailing slashes. It serves the
# binaries this script installs, so https, or http to this machine only.
RELEASES_URL="${GRAYBOARD_RELEASES_URL:-https://github.com}"
while [ "${RELEASES_URL%/}" != "$RELEASES_URL" ]; do RELEASES_URL="${RELEASES_URL%/}"; done
case "$RELEASES_URL" in
  *@*) echo "grayboard: GRAYBOARD_RELEASES_URL must not carry user info: ${GRAYBOARD_RELEASES_URL}" >&2; exit 1 ;;
  https://* | http://localhost | http://localhost:* | http://localhost/* | http://127.0.0.1 | http://127.0.0.1:* | http://127.0.0.1/* | "http://[::1]" | "http://[::1]:"* | "http://[::1]/"*) ;;
  *) echo "grayboard: GRAYBOARD_RELEASES_URL must be https (or http to localhost): ${GRAYBOARD_RELEASES_URL}" >&2; exit 1 ;;
esac
VERSION="${GRAYBOARD_VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_SERVER="${INSTALL_SERVER:-0}"
# Where a server install puts the release's deploy files (#311).
unit_dest="${GRAYBOARD_UNIT_DIR:-/etc/systemd/system}/grayboard.service"
caddy_dest="${GRAYBOARD_CADDYFILE:-/etc/caddy/Caddyfile}"
backup_dest="${INSTALL_DIR}/grayboard-backup"
DEPLOY_REPLACE="${GRAYBOARD_DEPLOY_REPLACE:-0}"

# ── detect platform ──────────────────────────────────────────────────────────

uname_os="$(uname -s)"
uname_arch="$(uname -m)"

case "$uname_os" in
  Linux)  os="linux"  ;;
  Darwin) os="darwin" ;;
  *) echo "grayboard: unsupported OS '$uname_os'. Linux and macOS only." >&2; exit 1 ;;
esac

case "$uname_arch" in
  x86_64|amd64) arch="x64"   ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "grayboard: unsupported architecture '$uname_arch'. x86_64 and arm64 only." >&2; exit 1 ;;
esac

target="${os}-${arch}"
echo "grayboard: detected ${target}"

# ── resolve version ──────────────────────────────────────────────────────────

# Resolve "latest" to its tag once, so every binary comes from one release and a
# server install knows which version /healthz must report.
if [ "$VERSION" = "latest" ]; then
  latest_url="$(curl "${CURL_LIMITS[@]}" -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES_URL}/${REPO}/releases/latest")" || {
    echo "grayboard: couldn't resolve the latest release of ${REPO} from ${RELEASES_URL}" >&2; exit 1; }
  VERSION="${latest_url##*/}"
fi
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || {
  echo "grayboard: '${VERSION}' isn't a release tag (vX.Y.Z)" >&2; exit 1; }
echo "grayboard: installing ${VERSION}"
base_url="${RELEASES_URL}/${REPO}/releases/download/${VERSION}"

# The GitHub release API publishes a sha256 digest per asset; the download
# origin alone doesn't. On github.com the API lives on api.github.com; a
# GRAYBOARD_RELEASES_URL mirror serves both paths on one origin (#173).
case "${RELEASES_URL}" in
  https://github.com) API_BASE="https://api.github.com" ;;
  *) API_BASE="${RELEASES_URL}" ;;
esac
release_api="${API_BASE}/repos/${REPO}/releases/tags/${VERSION}"

# ── sha256 helpers ───────────────────────────────────────────────────────────

binary_sum() {
  case "$(uname -s)" in
    Darwin) shasum -a 256 "$1" | awk '{print $1}' ;;
    *) sha256sum "$1" | awk '{print $1}' ;;
  esac
}

# The digest the release's API response lists for asset $2 ($1 = the release's
# API URL). GitHub's JSON is line-oriented, so split objects onto lines and
# take the digest that follows the asset's name. api.github.com pretty-prints
# ("name": "x"), mirrors may serve compact ("name":"x"): the patterns allow
# either. Validated against the live API before use (#173).
asset_digest() {
  # awk reads to EOF: an early exit would SIGPIPE curl or tr on a large
  # response, and pipefail would turn that into a missing digest.
  curl "${CURL_LIMITS[@]}" -fsSL -H "Accept: application/vnd.github+json" "$1" \
    | tr ',{}' '\n' \
    | awk -v name="$2" '
        /"name":/ { seen = ($0 ~ "\"name\": ?\"" name "\"") }
        seen && !found && /"digest":/ { sub(/.*"digest": ?"/, ""); sub(/".*/, ""); print; found = 1 }
      '
}

# ── release keys ─────────────────────────────────────────────────────────────

# BEGIN RELEASE KEYS (generated by `bun scripts/release_keys.ts sync` from assets/release-keys; don't edit by hand)
release_key() {
  case "$1" in
    0366b64814e1912c) cat <<'PEM'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhiZ6T4zhz9yX8lkFR7HtFX7We5h/
1j5L7TqPZCIL7U/q6tMJJu0yB0zqCikHZnHJrFyIZeQ4S1PTJY1AKyQ3kw==
-----END PUBLIC KEY-----
PEM
      ;;
    *) return 1 ;;
  esac
}
# END RELEASE KEYS

# ── download and verify ──────────────────────────────────────────────────────

bins=(grayboard)
deploy=0
deploy_assets=(deploy-grayboard.service deploy-Caddyfile deploy-backup.sh)
if [ "$INSTALL_SERVER" = "1" ]; then
  bins+=(grayboard-server)
  [ "${GRAYBOARD_NO_DEPLOY:-0}" = "1" ] || deploy=1
fi

# Inside INSTALL_DIR, so each final mv is a rename on one filesystem.
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d "${INSTALL_DIR}/.grayboard-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

refuse() { echo "grayboard: $*; not installing." >&2; exit 1; }

# fetch <asset> <file in tmp>
fetch() {
  echo "grayboard: downloading ${base_url}/$1"
  curl "${CURL_LIMITS[@]}" -fsSL -o "${tmp}/$2" "${base_url}/$1" || refuse "couldn't download ${base_url}/$1"
}

# SHA256SUMS.sig is one line: the signing key's id and the base64 DER signature.
fetch SHA256SUMS SHA256SUMS
fetch SHA256SUMS.sig SHA256SUMS.sig
# Parsed as strictly as src/shared/release_verify.ts: exactly that line, at
# most one trailing newline.
sigline="$(cat "${tmp}/SHA256SUMS.sig")"
[ "$(wc -c < "${tmp}/SHA256SUMS.sig")" -le "$(( ${#sigline} + 1 ))" ] \
  && [[ "$sigline" =~ ^([0-9a-f]{16})\ ([A-Za-z0-9+/]+={0,2})$ ]] \
  || refuse "SHA256SUMS.sig isn't \"<key id> <base64 signature>\""
keyid="${BASH_REMATCH[1]}" b64="${BASH_REMATCH[2]}"
release_key "$keyid" > "${tmp}/key.pem" || refuse "SHA256SUMS.sig: unknown key id ${keyid}"
# openssl base64 -d exits 0 on garbage; a P-256 DER signature is 8–72 bytes.
printf '%s' "$b64" | openssl base64 -d -A > "${tmp}/sig.der" || true
siglen="$(wc -c < "${tmp}/sig.der")"
[ "$siglen" -ge 8 ] && [ "$siglen" -le 72 ] || refuse "SHA256SUMS.sig: malformed signature (${siglen// /} bytes decoded)"
openssl dgst -sha256 -verify "${tmp}/key.pem" -signature "${tmp}/sig.der" "${tmp}/SHA256SUMS" >/dev/null 2>&1 \
  || refuse "SHA256SUMS.sig: the signature doesn't verify against SHA256SUMS with key ${keyid}"
# The same shape src/shared/release_verify.ts parseSums accepts: the tag line,
# then "<64 hex>  <name>" per line, no name twice; anything else refuses.
sums_bad="$(awk '
  /\r/ { print "has a malformed line"; exit }
  NR == 1 { if ($0 !~ /^# grayboard [^ \t]+$/) { print "has no \"# grayboard <tag>\" first line"; exit } next }
  # No {64} interval: mawk (the Debian default awk) may lack them.
  NF != 2 || $0 != $1 "  " $2 || length($1) != 64 || $1 ~ /[^0-9a-f]/ { print "has a malformed line"; exit }
  seen[$2]++ { print "lists " $2 " twice"; exit }
' "${tmp}/SHA256SUMS")"
[ -z "$sums_bad" ] || refuse "SHA256SUMS ${sums_bad}"
tagline="$(head -n 1 "${tmp}/SHA256SUMS")"
[ "$tagline" = "# grayboard ${VERSION}" ] || refuse "SHA256SUMS is signed for ${tagline#\# grayboard }, not ${VERSION}"

# verified <asset> <file in tmp>: download $1 only once SHA256SUMS and the
# release API both list a sha256 for it, then require the file to match both.
verified() {
  local asset="$1" want_sum want_api got
  want_sum="$(awk -v n="$asset" 'NR > 1 && $2 == n { print $1 }' "${tmp}/SHA256SUMS")"
  [[ "$want_sum" =~ ^[0-9a-f]{64}$ ]] || refuse "${asset}: SHA256SUMS lists no sha256"
  want_api="$(asset_digest "$release_api" "$asset")" || want_api=""
  case "$want_api" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) refuse "${asset}: the release API lists no sha256 digest" ;;
  esac
  fetch "$asset" "$2"
  got="$(binary_sum "${tmp}/$2")"
  [ "$got" = "$want_sum" ] || refuse "${asset}: sha256 ${got}, but SHA256SUMS lists ${want_sum}"
  [ "$got" = "${want_api#sha256:}" ] || refuse "${asset}: sha256 ${got}, but the release API lists ${want_api}"
}

for bin in "${bins[@]}"; do
  verified "${bin}-${target}" "$bin"
  chmod +x "${tmp}/${bin}"
done

# A server install also takes the release's deploy files: the unit, the
# Caddyfile and the backup script run as root or decide what does, so they
# share the binaries' trust root rather than a raw fetch of master (#311).
if [ "$deploy" = "1" ]; then
  for f in "${deploy_assets[@]}"; do
    verified "$f" "$f"
  done
fi

reported="$("${tmp}/grayboard" --version 2>/dev/null)" || reported=""
[ "$reported" = "${VERSION#v}" ] || refuse "the downloaded grayboard reports '${reported}', not ${VERSION}"
echo "grayboard: verified ${VERSION} (SHA256SUMS signed by key ${keyid})"

# place <staged> <dest> <mode>: write beside dest, then rename over it.
place() {
  { mkdir -p "$(dirname "$2")" && install -m "$3" "${tmp}/$1" "$2.new" && mv "$2.new" "$2"; } \
    || { rm -f "$2.new" 2>/dev/null || true; refuse "couldn't write $2 (run as root?)"; }
}

# The unit and the Caddyfile are the operator's once placed (a source-mode
# ExecStart, the real hostname), and a Caddy package ships its own Caddyfile,
# so a file that differs from the release's is kept and said so; a replace
# keeps the old one as <file>.prev. The backup script is configured by
# environment only, so it's replaced like a binary.
unit_new=0 unit_changed=0
if [ "$deploy" = "1" ]; then
  # keep_or_place <asset> <dest> <what>; sets placed=1 when it wrote dest.
  keep_or_place() {
    placed=0
    if [ ! -e "$2" ]; then
      place "$1" "$2" 644; placed=1; echo "grayboard: installed $2"
    elif cmp -s "${tmp}/$1" "$2"; then
      :
    elif [ "$DEPLOY_REPLACE" = "1" ]; then
      cp -p "$2" "$2.prev" || refuse "couldn't back up $2 to $2.prev"
      place "$1" "$2" 644; placed=1; echo "grayboard: replaced $2 (the old one is $2.prev)"
    else
      echo "grayboard: kept your $2: it differs from the ${3} in this release (GRAYBOARD_DEPLOY_REPLACE=1 replaces it, keeping the old as $2.prev)"
    fi
  }
  if [ ! -e "$unit_dest" ] && command -v systemctl >/dev/null 2>&1 && systemctl cat grayboard >/dev/null 2>&1; then
    echo "grayboard: the grayboard unit is defined outside ${unit_dest}; left alone"
  else
    [ -e "$unit_dest" ] || unit_new=1
    keep_or_place deploy-grayboard.service "$unit_dest" "unit"
    unit_changed="$placed"
  fi
  keep_or_place deploy-Caddyfile "$caddy_dest" "Caddyfile"
  place deploy-backup.sh "$backup_dest" 755
  echo "grayboard: installed ${backup_dest}"
fi

# Every binary passed; only now is any replaced. Keep the server binary being
# replaced, so a release that won't start can be rolled back; that copy is
# taken before any rename, so a failed copy leaves both binaries old.
if [ "$INSTALL_SERVER" = "1" ] && [ -f "${INSTALL_DIR}/grayboard-server" ]; then
  cp -p "${INSTALL_DIR}/grayboard-server" "${INSTALL_DIR}/grayboard-server.prev" \
    || refuse "couldn't back up ${INSTALL_DIR}/grayboard-server to grayboard-server.prev"
fi

for bin in "${bins[@]}"; do
  mv "${tmp}/${bin}" "${INSTALL_DIR}/${bin}"
done

if [ "$unit_changed" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || { echo "grayboard: systemctl daemon-reload failed after writing ${unit_dest} (run as root?)" >&2; exit 1; }
fi

# ── PATH check ───────────────────────────────────────────────────────────────

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "grayboard: ${INSTALL_DIR} is not on your PATH."
    echo "  Add this to your shell profile:"
    echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo
echo "grayboard installed to ${INSTALL_DIR}"
echo

# The grayboard unit's binary, when systemd knows the unit; empty otherwise.
unit_bin=""
if [ "$INSTALL_SERVER" = "1" ] && [ "$unit_new" != "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl cat grayboard >/dev/null 2>&1; then
  unit_bin="$(systemctl show -p ExecStart --value grayboard | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
fi

if [ -n "$unit_bin" ] && ! [ "$unit_bin" -ef "${INSTALL_DIR}/grayboard-server" ]; then
  echo "The grayboard unit runs ${unit_bin}, not ${INSTALL_DIR}/grayboard-server; it was not restarted."
elif [ -n "$unit_bin" ] && [ "$(systemctl show -p ActiveState --value grayboard)" = "inactive" ]; then
  echo "The grayboard unit is stopped; \`systemctl start grayboard\` runs ${VERSION}."
elif [ -n "$unit_bin" ]; then
  # An upgrade: the running process holds the old binary until restarted. The unit is
  # Type=simple, so systemd calls it active as soon as it forks; only /healthz reporting
  # the new version shows the release started.
  rollback="cp -p ${INSTALL_DIR}/grayboard-server.prev ${INSTALL_DIR}/grayboard-server && systemctl restart grayboard"
  systemctl restart grayboard || {
    echo "grayboard: systemctl restart failed; the old process may still be serving (run as root?)" >&2; exit 1; }
  env_file="$(systemctl show -p EnvironmentFiles --value grayboard | sed -n 's/^\([^ ]*\).*/\1/p')"
  port="$(sed -n 's/^GRAYBOARD_HTTP_PORT=\([0-9]*\).*/\1/p' "${env_file:-/dev/null}" 2>/dev/null | tail -1)"
  want="${VERSION#v}" got=""
  for _ in $(seq 30); do
    got="$(curl -fsS --max-time 2 "http://127.0.0.1:${port:-8080}/healthz" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')" || true
    [ "$got" = "$want" ] && break
    sleep 1
  done
  if [ "$got" != "$want" ]; then
    echo "grayboard: after restart, /healthz on port ${port:-8080} reports '${got:-no answer}', not ${want}." >&2
    echo "  Diagnose: journalctl -u grayboard -n 50" >&2
    [ -f "${INSTALL_DIR}/grayboard-server.prev" ] && echo "  Roll back: ${rollback}" >&2
    exit 1
  fi
  echo "Restarted the grayboard service; /healthz reports ${got}."
elif [ "$unit_new" = "1" ]; then
  echo "Server installed with the release's unit (${unit_dest}), Caddyfile (${caddy_dest}) and"
  echo "backup script (${backup_dest}). The service isn't started: set your hostname in the"
  echo "Caddyfile, create /etc/grayboard/env (GRAYBOARD_DB_PATH, GRAYBOARD_PUBLIC_URL,"
  echo "GRAYBOARD_ORG_DOMAIN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET), then"
  echo "\`systemctl enable --now grayboard\`."
elif [ "$INSTALL_SERVER" = "1" ]; then
  echo "Server binary installed; no grayboard systemd unit found. A server already running"
  echo "from this binary keeps the old version until you restart it. For a new server, rerun"
  echo "without GRAYBOARD_NO_DEPLOY=1 (it installs the unit, Caddyfile and backup script),"
  echo "then create /etc/grayboard/env with GRAYBOARD_DB_PATH, GRAYBOARD_PUBLIC_URL,"
  echo "GRAYBOARD_ORG_DOMAIN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET."
elif [ "${GRAYBOARD_NO_SETUP:-0}" != "1" ] && [ -t 1 ] && (: < /dev/tty) 2>/dev/null; then
  # Under `curl | bash`, stdin is this script; setup asks its questions on the terminal.
  "${INSTALL_DIR}/grayboard" setup < /dev/tty
else
  echo "Next: run \`grayboard setup\` to choose local or team-server mode and connect Claude Code."
fi
