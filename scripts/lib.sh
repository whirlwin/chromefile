# Shared paths for install.sh and uninstall.sh. Sourced, not executed.
# shellcheck shell=bash disable=SC2034 # the variables are used by the scripts that source this

HOST_NAME="io.whirlwin.claude_browser_bridge"
MCP_NAME="claude-browser-bridge"

case "$(uname -s)" in
  Darwin)
    APP_DIR="$HOME/Library/Application Support/claude-browser-bridge"
    # Browser data dir, relative to ~/Library/Application Support, and a label.
    BROWSERS=(
      "Google/Chrome|Chrome"
      "Google/Chrome Beta|Chrome Beta"
      "Google/Chrome Canary|Chrome Canary"
      "Google/Chrome for Testing|Chrome for Testing"
      "Chromium|Chromium"
      "BraveSoftware/Brave-Browser|Brave"
      "Microsoft Edge|Edge"
      "Vivaldi|Vivaldi"
      "Arc/User Data|Arc"
    )
    BROWSER_ROOT="$HOME/Library/Application Support"
    ;;
  Linux)
    APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claude-browser-bridge"
    BROWSERS=(
      "google-chrome|Chrome"
      "google-chrome-beta|Chrome Beta"
      "google-chrome-unstable|Chrome Dev"
      "chromium|Chromium"
      "BraveSoftware/Brave-Browser|Brave"
      "microsoft-edge|Edge"
      "vivaldi|Vivaldi"
    )
    BROWSER_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
    ;;
  *)
    echo "Unsupported OS: $(uname -s) (macOS and Linux only)" >&2
    exit 1
    ;;
esac

WRAPPER="$APP_DIR/cbb-host"
MANIFEST_NAME="$HOST_NAME.json"
