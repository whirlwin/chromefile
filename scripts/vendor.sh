#!/usr/bin/env bash
# Copies the extension and host builds into the Rust crate, where the
# chromefile binary embeds them: extension/dist to cli/extension/ and
# host/dist/chromefile-host.js to cli/host/. They are committed, so that
# `cargo install --git` works without Node; CI fails if they are stale.
#
# Usage: scripts/vendor.sh [--no-build]
#
# Runs `npm run build` first unless --no-build is given.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

build=true
while (($#)); do
  case "$1" in
    --no-build) build=false ;;
    -h | --help)
      sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if $build; then
  (cd "$REPO" && npm run build)
fi

dist="$REPO/extension/dist"
host="$REPO/host/dist/chromefile-host.js"
for f in "$dist/manifest.json" "$host"; do
  [[ -f "$f" ]] || {
    echo "error: $f not found; run npm run build first" >&2
    exit 1
  }
done

rm -rf "$REPO/cli/extension" "$REPO/cli/host"
mkdir -p "$REPO/cli/extension" "$REPO/cli/host"
cp -R "$dist/." "$REPO/cli/extension/"
cp "$host" "$REPO/cli/host/chromefile-host.js"

echo "vendored extension/dist to cli/extension and $(basename "$host") to cli/host"
