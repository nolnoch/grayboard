#!/usr/bin/env bash
# grayboard installer — downloads release binaries and drops them into a bin dir.
#
# Default install (developer machine):
#   curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh | bash
#   → installs `grayboard` to ~/.local/bin, then runs `grayboard setup`
#
# Server install (one-deployment-per-org):
#   curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh \
#     | sudo INSTALL_SERVER=1 INSTALL_DIR=/usr/local/bin bash
#   → also installs `grayboard-server`; if the grayboard systemd unit runs that binary,
#     restarts it and waits for /healthz to report the installed release
#
# Overrides:
#   GRAYBOARD_VERSION=v1.0.0   pin a release (default: latest)
#   INSTALL_DIR=/some/path     install dir   (default: ~/.local/bin)
#   GRAYBOARD_REPO=fork/repo   alternate repo
#   GRAYBOARD_RELEASES_URL=https://mirror.example.com
#                              serves github.com's release paths instead of github.com
#   INSTALL_SERVER=1           also fetch grayboard-server
#   GRAYBOARD_NO_SETUP=1       skip `grayboard setup`

set -euo pipefail

REPO="${GRAYBOARD_REPO:-nolnoch/grayboard}"
RELEASES_URL="${GRAYBOARD_RELEASES_URL:-https://github.com}"
RELEASES_URL="${RELEASES_URL%/}"
VERSION="${GRAYBOARD_VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_SERVER="${INSTALL_SERVER:-0}"

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
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES_URL}/${REPO}/releases/latest")" || {
    echo "grayboard: couldn't resolve the latest release of ${REPO}" >&2; exit 1; }
  VERSION="${latest_url##*/}"
fi
echo "grayboard: installing ${VERSION}"
base_url="${RELEASES_URL}/${REPO}/releases/download/${VERSION}"

# ── pick binaries ────────────────────────────────────────────────────────────

bins=(grayboard)
if [ "$INSTALL_SERVER" = "1" ]; then
  bins+=(grayboard-server)
fi

# ── download ─────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for bin in "${bins[@]}"; do
  url="${base_url}/${bin}-${target}"
  echo "grayboard: downloading ${url}"
  if ! curl -fsSL -o "${tmp}/${bin}" "$url"; then
    echo "grayboard: failed to download ${url}" >&2
    exit 1
  fi
  chmod +x "${tmp}/${bin}"
  # Keep the server binary being replaced, so a release that won't start can be rolled back.
  if [ "$bin" = "grayboard-server" ] && [ -f "${INSTALL_DIR}/${bin}" ]; then
    cp -p "${INSTALL_DIR}/${bin}" "${INSTALL_DIR}/${bin}.prev"
  fi
  mv "${tmp}/${bin}" "${INSTALL_DIR}/${bin}"
done

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
if [ "$INSTALL_SERVER" = "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl cat grayboard >/dev/null 2>&1; then
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
elif [ "$INSTALL_SERVER" = "1" ]; then
  echo "Server binary installed; no grayboard systemd unit found. A server already running"
  echo "from this binary keeps the old version until you restart it. For a new server:"
  echo "  1. Create /etc/grayboard/env with GRAYBOARD_DB_PATH, GRAYBOARD_PUBLIC_URL,"
  echo "     GRAYBOARD_ORG_DOMAIN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET"
  echo "  2. Install the systemd unit (deploy/grayboard.service in the repo)"
  echo "  3. Put Caddy in front for TLS (deploy/Caddyfile)"
  echo "  4. Schedule the nightly backup cron (deploy/backup.sh)"
elif [ "${GRAYBOARD_NO_SETUP:-0}" != "1" ] && [ -t 1 ] && (: < /dev/tty) 2>/dev/null; then
  # Under `curl | bash`, stdin is this script; setup asks its questions on the terminal.
  "${INSTALL_DIR}/grayboard" setup < /dev/tty
else
  echo "Next: run \`grayboard setup\` to choose local or team-server mode and connect Claude Code."
fi
