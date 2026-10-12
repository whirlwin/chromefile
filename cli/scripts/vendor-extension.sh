#!/usr/bin/env bash
# Vendors the Claude Browser Bridge extension build into this crate, where
# include_dir embeds it into the chromefile binary.
#
# Usage: scripts/vendor-extension.sh [--no-build] [path/to/claude-browser-bridge]
#
# Builds the extension there (npm run build) unless --no-build is given, copies
# extension/dist over extensions/claude-browser-bridge and records the bridge
# commit it came from in extensions/claude-browser-bridge.source.
set -euo pipefail

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$CLI/extensions/claude-browser-bridge"

build=true
bridge=""
while (($#)); do
  case "$1" in
    --no-build) build=false ;;
    -h | --help)
      sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      exit 1
      ;;
    *) bridge="$1" ;;
  esac
  shift
done
bridge="${bridge:-$CLI/../../claude-browser-bridge}"
[[ -d "$bridge" ]] || {
  echo "error: $bridge is not a directory" >&2
  exit 1
}
bridge="$(cd "$bridge" && pwd)"

if $build; then
  (cd "$bridge" && npm run build)
fi

dist="$bridge/extension/dist"
[[ -f "$dist/manifest.json" ]] || {
  echo "error: $dist/manifest.json not found; build the extension first" >&2
  exit 1
}

sha="$(git -C "$bridge" rev-parse HEAD)"
dirty=""
[[ -z "$(git -C "$bridge" status --porcelain)" ]] || dirty=" (working tree had uncommitted changes)"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$dist/." "$DEST/"
printf 'https://github.com/whirlwin/claude-browser-bridge/commit/%s%s\n' "$sha" "$dirty" > "$DEST.source"

echo "vendored $dist at $sha$dirty"
