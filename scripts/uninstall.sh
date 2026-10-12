#!/usr/bin/env bash
# Undoes scripts/install.sh: removes the native host manifests, the wrapper
# and the Claude Code MCP registration. The extension itself is removed from
# chrome://extensions. Safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "$REPO/scripts/lib.sh"

for entry in "${BROWSERS[@]}"; do
  manifest="$BROWSER_ROOT/${entry%%|*}/NativeMessagingHosts/$MANIFEST_NAME"
  if [[ -f "$manifest" ]]; then
    rm -f "$manifest"
    echo "Removed ${entry#*|} manifest: $manifest"
  fi
done

if [[ -f "$WRAPPER" ]]; then
  rm -f "$WRAPPER"
  echo "Removed $WRAPPER"
fi
# Leaves the directory if a running host still has its socket there.
rmdir "$APP_DIR" 2> /dev/null || true

if command -v claude > /dev/null; then
  if claude mcp remove --scope user "$MCP_NAME" > /dev/null 2>&1; then
    echo "Removed MCP server $MCP_NAME from Claude Code"
  fi
fi

echo "Remove the extension itself from chrome://extensions."
