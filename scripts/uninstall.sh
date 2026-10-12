#!/usr/bin/env bash
# Undoes scripts/install.sh: `chromefile uninstall` removes the extension,
# the native messaging host manifests, the MCP registration and the host. It
# keeps config.json and sessions/. Arguments go to `chromefile uninstall`.
# The binary itself stays; remove it with `cargo uninstall chromefile`.
set -euo pipefail

exec chromefile uninstall "$@"
