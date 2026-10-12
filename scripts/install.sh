#!/usr/bin/env bash
# Builds and installs chromefile from this checkout, then runs
# `chromefile install`, which sets up the host, the native messaging host,
# the Claude Code MCP server and the extension. Arguments go to
# `chromefile install` (for example --replace). Safe to re-run: do so after
# pulling changes or switching Node versions.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "==> Building the extension and host with node $(node --version)"
[[ -d node_modules ]] || npm ci
npm run build
scripts/vendor.sh --no-build

echo "==> Installing the chromefile binary"
cargo install --path cli --locked

# The copy just installed, even if another chromefile comes first on PATH.
chromefile="${CARGO_INSTALL_ROOT:-${CARGO_HOME:-$HOME/.cargo}}/bin/chromefile"
echo "==> $chromefile install $*"
exec "$chromefile" install "$@"
