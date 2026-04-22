#!/usr/bin/env bash
# grayboard installer — downloads the grayboard CLI and plugin binaries
# from the latest GitHub release and drops them into ~/.local/bin.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/nolnoch/grayboard/master/install.sh | bash
#
# Override the version with GRAYBOARD_VERSION=v0.1.0 (default: latest).
# Override the install dir with INSTALL_DIR=/some/path  (default: ~/.local/bin).

set -euo pipefail

REPO="${GRAYBOARD_REPO:-nolnoch/grayboard}"
VERSION="${GRAYBOARD_VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

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

# ── download ─────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for bin in grayboard grayboard-plugin; do
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
echo "Next steps:"
echo "  1. export GRAYBOARD_SERVER=https://your-grayboard-host"
echo "  2. export GRAYBOARD_ORG_DOMAIN=your-org.com"
echo "  3. export GOOGLE_OAUTH_CLIENT_ID=<the Google OAuth client_id>"
echo "  4. grayboard login"
echo "  5. cd into a repo and run: grayboard identity create <name> --mcp"
