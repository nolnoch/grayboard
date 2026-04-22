#!/usr/bin/env bash
# grayboard installer — downloads release binaries and drops them into a bin dir.
#
# Default install (developer machine):
#   curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh | bash
#   → installs `grayboard` and `grayboard-plugin` to ~/.local/bin
#
# Server install (one-deployment-per-org):
#   curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh \
#     | INSTALL_SERVER=1 INSTALL_DIR=/usr/local/bin bash
#   → also installs `grayboard-server`
#
# Overrides:
#   GRAYBOARD_VERSION=v0.1.0   pin a release (default: latest)
#   INSTALL_DIR=/some/path     install dir   (default: ~/.local/bin)
#   GRAYBOARD_REPO=fork/repo   alternate repo
#   INSTALL_SERVER=1           also fetch grayboard-server

set -euo pipefail

REPO="${GRAYBOARD_REPO:-nolnoch/grayboard}"
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

if [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/${REPO}/releases/latest/download"
else
  base_url="https://github.com/${REPO}/releases/download/${VERSION}"
fi

# ── pick binaries ────────────────────────────────────────────────────────────

bins=(grayboard grayboard-plugin)
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

if [ "$INSTALL_SERVER" = "1" ]; then
  echo "Server binary installed. Next:"
  echo "  1. Create /etc/grayboard/env with GRAYBOARD_DB_PATH, GRAYBOARD_PUBLIC_URL,"
  echo "     GRAYBOARD_ORG_DOMAIN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET"
  echo "  2. Install the systemd unit (deploy/grayboard.service in the repo)"
  echo "  3. Put Caddy in front for TLS (deploy/Caddyfile)"
  echo "  4. Schedule the nightly backup cron (deploy/backup.sh)"
else
  echo "Next steps:"
  echo "  1. grayboard login --server https://your-grayboard-host"
  echo "  2. cd into a repo and run: grayboard identity create <name> --mcp"
fi
