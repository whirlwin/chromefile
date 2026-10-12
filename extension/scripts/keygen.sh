#!/usr/bin/env bash
# Creates the signing key that pins the extension ID, then prints the manifest
# `key` and writes the ID to extension-id.txt. Safe to re-run: an existing
# key.pem is kept, so the ID never changes once generated.
#
# Chrome derives an unpacked extension's ID from the manifest `key`: the first
# 32 hex digits of sha256(SPKI DER public key), with 0-f mapped to a-p.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f key.pem ]]; then
  openssl genrsa -out key.pem 2048 2>/dev/null
  chmod 600 key.pem
  echo "Generated key.pem (keep it private; it is gitignored)" >&2
fi

pubkey_der() { openssl rsa -in key.pem -pubout -outform DER 2>/dev/null; }

key=$(pubkey_der | openssl base64 -A)
id=$(pubkey_der | openssl dgst -sha256 -binary | xxd -p -c 256 | cut -c1-32 | tr 0-9a-f a-p)

printf '%s\n' "$id" > extension-id.txt
echo "manifest key: $key"
echo "extension id: $id"
