#!/usr/bin/env bash
# Tests the mod assets, disabled mods (`enabled: false`), claude.personas,
# --check and the user config of scripts/chrome-apply.sh without Chrome:
# configs with only mods or claude keys, a stub `chromefile` (CHROMEFILE_CMD)
# that keeps registered mods in files, an `osascript` on PATH that fails if
# anything calls it, file:// assets (CHROMEFILE_ASSET_ALLOW_FILE=1), a temp app
# directory (CHROMEFILE_HOME) for config.json, and HOME and XDG_CONFIG_HOME
# inside the temp directory, so your own user config is never read. Last, the
# shortcut strings the script sends Chrome, from its functions alone. macOS
# only, like the script.
#
# Usage: scripts/test/chrome-apply-assets.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state" "$T/home"

cat > "$T/bin/osascript" << EOF2
#!/bin/sh
echo called >> '$T/osascript-called'
exit 1
EOF2
cat > "$T/bin/chromefile" << 'EOF2'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == call ]] || exit 9
case "$2" in
  mods.list)
    if compgen -G "$STATE/*.json" > /dev/null; then
      yq ea -p=json -o=json -I=0 '. as $m ireduce ([]; . + [$m]) | {"mods": .}' "$STATE"/*.json
    else
      echo '{"mods":[]}'
    fi
    ;;
  mods.register)
    id="$(yq -p=json -r '.id' <<< "$3")"
    printf '%s' "$3" > "$STATE/$id.json"
    echo '{}'
    ;;
  mods.unregister)
    while IFS= read -r id; do
      rm -f "$STATE/$id.json"
    done < <(yq -p=json -r '.ids[]' <<< "$3")
    echo '{}'
    ;;
  *) exit 9 ;;
esac
EOF2
chmod +x "$T/bin/osascript" "$T/bin/chromefile"
# Some runs point HOME into $T, where a mise shim would not find its tools.
ln -s "$(mise which yq 2> /dev/null || command -v yq)" "$T/bin/yq"

# A 1x1 PNG, and a text file posing as an image.
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > "$T/dot.png"
echo 'not an image' > "$T/fake.png"
want_uri="data:image/png;base64,$(base64 < "$T/dot.png" | tr -d '\n')"

printf '%s\n' 'const a = "__ASSET_DOT__";' 'const b = "__ASSET_DOT__" + "&\\";' 'const c = "__ASSET_OTHER__";' > "$T/mod.js"
echo 'console.log("plain");' > "$T/plain.js"

write_config() {
  cat > "$T/chrome.yaml" << EOF2
mods:
  with-assets:
    matches: ["https://example.com/*"]
    file: mod.js
    assets:
      DOT: $1
  plain:
    matches: ["https://example.com/*"]
    file: plain.js
EOF2
}

# apply [OPTION...]: runs chrome-apply.sh on $T/chrome.yaml (or $CONFIG),
# output in OUT.
apply() {
  local rc=0
  OUT="$(PATH="$T/bin:$PATH" STATE="$T/state" CHROMEFILE_CMD="$T/bin/chromefile" CHROMEFILE_HOME="$T/home" \
    CHROMEFILE_ASSET_ALLOW_FILE="${ALLOW_FILE:-1}" "$REPO/scripts/chrome-apply.sh" "$@" "${CONFIG:-$T/chrome.yaml}" 2>&1)" || rc=$?
  return "$rc"
}

# check NAME: reports the exit status of the command before it.
failures=0
check() {
  if (($? == 0)); then
    echo "ok   $1"
  else
    echo "FAIL $1"
    printf '%s\n' "$OUT" | sed 's/^/     /'
    failures=$((failures + 1))
  fi
}

write_config "file://$T/dot.png"
apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"changed    mods.with-assets: registered"* && "$OUT" == *"changed    mods.plain: registered"* ]]
check "applies and registers both mods"
js="$(yq -p=json -o=json -r '.js' "$T/state/with-assets.json")"
expected="$(printf '%s\n' "const a = \"$want_uri\";" "const b = \"$want_uri\" + \"&\\\\\";" 'const c = "__ASSET_OTHER__";')"
[[ "$js" == "$expected" ]]
check "replaces every placeholder literally, leaves undeclared ones"
[[ ! -e "$T/osascript-called" ]]
check "never runs osascript"

apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  mods.with-assets"* && "$OUT" == *"unchanged  mods.plain"* ]]
check "second run is unchanged (compares the inlined code)"

rm -f "$T"/state/*.json
write_config "file://$T/fake.png"
apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"mods.with-assets: asset DOT: "*"not an image"* && "$OUT" == *"changed    mods.plain: registered"* && ! -e "$T/state/with-assets.json" ]]
check "rejects a non-image, still applies the other mod"

write_config "http://127.0.0.1:9/dot.png"
apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"only https:// URLs are allowed"* ]]
check "rejects plain http"

write_config "file://$T/dot.png"
ALLOW_FILE=0 apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"only https:// URLs are allowed"* ]]
check "rejects file:// unless the test override is set"

head -c 300000 /dev/zero > "$T/big.png"
write_config "file://$T/big.png"
apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"more than 262144"* ]]
check "rejects an asset over the size cap"

sed -i '' 's/DOT:/dot:/' "$T/chrome.yaml"
apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"asset name dot must match"* ]]
check "rejects a lowercase asset name"

# write_toggle_config LINE: `toggled` is a plain mod with LINE as its enabled
# key (or nothing); `broken` is disabled with a missing file and an asset URL
# the script would reject, so any check or download of it shows as an error.
write_toggle_config() {
  cat > "$T/chrome.yaml" << EOF2
mods:
  toggled:
    matches: ["https://example.com/*"]
    file: plain.js
    $1
  broken:
    matches: ["https://example.com/*"]
    file: missing.js
    enabled: false
    assets:
      DOT: http://127.0.0.1:9/dot.png
EOF2
}

rm -f "$T"/state/*.json
echo '{"id":"broken","matches":["https://example.com/*"],"js":"x"}' > "$T/state/broken.json"
write_toggle_config "enabled: true"
apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"changed    mods.toggled: registered"* && -e "$T/state/toggled.json" ]]
check "enabled: true registers the mod"
((rc == 0)) && [[ "$OUT" == *"removed    mods.broken (disabled)"* && "$OUT" != *error:* && ! -e "$T/state/broken.json" ]]
check "unregisters a disabled mod without checking its file or assets"

write_toggle_config ""
apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  mods.toggled"* && "$OUT" == *"unchanged  mods.broken (disabled)"* ]]
check "a missing enabled is the same as enabled: true"

write_toggle_config "enabled: false"
apply --dry-run
rc=$?
((rc == 0)) && [[ "$OUT" == *"would remove mods.toggled (disabled)"* && "$OUT" != *extra* && -e "$T/state/toggled.json" ]]
check "dry run reports the removal and keeps the mod"

apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"removed    mods.toggled (disabled)"* && ! -e "$T/state/toggled.json" ]]
check "enabled: false unregisters a registered mod"

apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  mods.toggled (disabled)"* ]]
check "second run with enabled: false is unchanged"

write_toggle_config "enabled: true"
apply
write_toggle_config 'enabled: "no"'
apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"mods.toggled: enabled must be true or false"* && -e "$T/state/toggled.json" ]]
check "rejects a non-boolean enabled and leaves the mod registered"

[[ ! -e "$T/osascript-called" ]]
check "never runs osascript (disabled mods)"

cat > "$T/second.yaml" << 'EOF2'
mods:
  second-only:
    matches: ["https://example.com/*"]
    file: plain.js
EOF2
HOME="$T" CONFIG="$T/second.yaml" apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"extra      mods.toggled is registered but not in ~/second.yaml (left alone)"* && "$OUT" == *"changed    mods.second-only: registered"* ]]
check "reports an extra mod against the file applied, by its path"

[[ ! -e "$T/home/config.json" ]]
check "configs with only mods leave config.json alone"

# Personas -------------------------------------------------------------------
# Every voice holds voice-marker, so a test can tell it never reaches the
# output. The `|` block keeps its trailing newline, and the shell must not
# expand anything in it.
write_personas() {
  cat > "$T/chrome.yaml" << 'EOF2'
claude:
  personas:
    example: Plain and short. voice-marker
    terse: |
      One line with $HOME, `date`, "quotes" and a \ backslash. voice-marker
        Indented, then a trailing newline. æøå
EOF2
}

rm -rf "${T:?}/home"
write_personas
apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"changed    claude.personas.example"* && "$OUT" == *"changed    claude.personas.terse"* && "$OUT" != *voice-marker* ]]
check "writes personas into a new config.json and never prints a voice"
[[ "$(stat -f %Lp "$T/home")" == 700 && "$(stat -f %Lp "$T/home/config.json")" == 600 && -z "$(find "$T/home" -name 'config.json.?*')" ]]
check "config.json is 600 in a 700 directory, no temp file left"
terse="$(yq -o=json -I=0 '.claude.personas.terse' "$T/chrome.yaml")"
[[ "$terse" == *'\n"' && "$(yq -p=json -o=json -I=0 '.claude.personas.terse' "$T/home/config.json")" == "$terse" ]]
check "a multi-line voice round-trips exactly"

apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  claude.personas.example"* && "$OUT" == *"unchanged  claude.personas.terse"* ]]
check "second run with personas is unchanged"

cp "$T/home/config.json" "$T/before.json"
sed -i '' 's/Plain and short/Plain and long/' "$T/chrome.yaml"
apply --dry-run
rc=$?
((rc == 0)) && [[ "$OUT" == *"would set  claude.personas.example"* && "$OUT" == *"unchanged  claude.personas.terse"* && "$OUT" != *voice-marker* ]] &&
  cmp -s "$T/before.json" "$T/home/config.json"
check "dry run reports a changed voice and writes nothing"

echo '{"node":"/x","claude":{"cwd":"/tmp","personas":{"other":"keep me"}}}' > "$T/home/config.json"
write_personas
apply
rc=$?
((rc == 0)) && [[ "$(yq -p=json -o=json -I=0 '[.node, .claude.cwd, .claude.personas.other, (.claude.personas | keys | sort)]' "$T/home/config.json")" == '["/x","/tmp","keep me",["example","other","terse"]]' ]]
check "keeps other keys and personas in config.json"

# claude.cwd shares the config.json code with personas.
mkdir -p "$T/work"
work="$(cd "$T/work" && pwd)"
rm -rf "${T:?}/home"
cat > "$T/chrome.yaml" << EOF2
claude:
  cwd: $T/work
  personas:
    example: Plain. voice-marker
EOF2
apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"changed    claude.cwd: (none) -> $work"* && "$OUT" == *"changed    claude.personas.example"* ]] &&
  [[ "$(yq -p=json -o=json -r '.claude.cwd' "$T/home/config.json")" == "$work" ]]
check "writes claude.cwd and a persona in one run"
apply
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  claude.cwd = $work"* && "$OUT" == *"unchanged  claude.personas.example"* ]]
check "second run with claude.cwd is unchanged"

printf '{not json' > "$T/home/config.json"
sed -i '' 's/Plain\./Changed./' "$T/chrome.yaml"
apply
rc=$?
((rc == 1)) && [[ "$(grep -c 'is not valid JSON; fix or remove it' <<< "$OUT")" == 1 && "$(cat "$T/home/config.json")" == '{not json' ]]
check "reports an invalid config.json once and leaves it as is"

rm -rf "${T:?}/home"
long="$(head -c 4001 /dev/zero | tr '\0' x)"
wide="$(head -c 4000 /dev/zero | tr '\0' x | sed 's/x/ø/g')"
cat > "$T/chrome.yaml" << EOF2
claude:
  personas:
    Bad_Name: A voice. voice-marker
    Bad: A voice. voice-marker
    number: 42
    list: [voice-marker]
    empty: ""
    blank: "   "
    long: $long
    max: ${long:1}
    wide: $wide
    good: A voice. voice-marker
EOF2
apply
rc=$?
name_err="name must be a-z, 0-9 and -, at most 32 characters, starting with a letter"
value_err="must be a non-empty string of at most 4000 characters"
((rc == 1)) && [[ "$OUT" == *"claude.personas.Bad_Name: $name_err"* && "$OUT" == *"claude.personas.Bad: $name_err"* ]] &&
  [[ "$OUT" == *"claude.personas.number: $value_err"* && "$OUT" == *"claude.personas.list: $value_err"* ]] &&
  [[ "$OUT" == *"claude.personas.empty: $value_err"* && "$OUT" == *"claude.personas.blank: $value_err"* ]] &&
  [[ "$OUT" == *"claude.personas.long: $value_err"* && "$OUT" == *"7 error(s); the rest was applied"* ]] &&
  [[ "$OUT" == *"changed    claude.personas.max"* && "$OUT" == *"changed    claude.personas.wide"* ]] &&
  [[ "$OUT" == *"changed    claude.personas.good"* && "$OUT" != *voice-marker* ]] &&
  [[ "$(yq -p=json -o=json -I=0 '.claude.personas | keys | sort' "$T/home/config.json")" == '["good","max","wide"]' ]]
check "rejects bad names and values, counts characters, writes the valid ones"

cat > "$T/chrome.yaml" << EOF2
claude:
  cwd: $T/work
  personas: [example, terse]
EOF2
apply
rc=$?
((rc == 1)) && [[ "$OUT" == *"error: claude.personas must be a map of name: voice"* && "$OUT" == *"changed    claude.cwd: (none) -> $work"* ]] &&
  [[ "$(yq -p=json -o=json -I=0 '.claude.personas | keys | sort' "$T/home/config.json")" == '["good","max","wide"]' ]]
check "rejects claude.personas that is not a map, still applies the rest"

[[ ! -e "$T/osascript-called" ]]
check "never runs osascript (personas)"

# --check ----------------------------------------------------------------------
# The dry run's output, with an exit status for drift: 0 in sync, 2 when
# something would change, 1 on an error, which wins over drift.

# write_check_config VOICE [LINE]: claude.cwd, a persona with VOICE, and a
# plain mod with LINE (such as its enabled key) added.
write_check_config() {
  cat > "$T/chrome.yaml" << EOF2
claude:
  cwd: $T/work
  personas:
    example: $1 voice-marker
mods:
  plain:
    matches: ["https://example.com/*"]
    file: plain.js
    ${2:-}
EOF2
}

rm -f "$T"/state/*.json
rm -rf "${T:?}/home"
write_check_config "Plain."
apply --check
rc=$?
check_out="$OUT"
((rc == 2)) && [[ "$OUT" == *"would set  mods.plain: not registered"* && "$OUT" == *"would set  claude.personas.example"* ]] &&
  [[ "$OUT" == *"would set  claude.cwd: (none) -> $work"* && ! -e "$T/state/plain.json" && ! -e "$T/home/config.json" ]]
check "--check: a mod not registered is drift (2), and nothing is registered"

apply --check --dry-run
rc=$?
((rc == 2)) && [[ "$OUT" == "$check_out" ]]
check "--check --dry-run is the same as --check"

apply --dry-run
rc=$?
((rc == 0)) && [[ "$OUT" == "$check_out" ]]
check "without --check, a dry run with drift has the same output and exits 0"

apply
apply --check
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  mods.plain"* && "$OUT" == *"unchanged  claude.personas.example"* ]] &&
  [[ "$OUT" == *"unchanged  claude.cwd = $work"* ]]
check "--check: in sync is 0"

cp "$T/home/config.json" "$T/before.json"
write_check_config "Changed."
apply --check
rc=$?
((rc == 2)) && [[ "$OUT" == *"would set  claude.personas.example"* && "$OUT" == *"unchanged  mods.plain"* ]] &&
  [[ "$OUT" == *"unchanged  claude.cwd"* ]] && cmp -s "$T/before.json" "$T/home/config.json"
check "--check: a persona that differs is drift (2), and config.json is unchanged"

write_check_config "Plain."
yq -i -p=json -o=json '.claude.cwd = "/tmp"' "$T/home/config.json"
cp "$T/home/config.json" "$T/before.json"
apply --check
rc=$?
((rc == 2)) && [[ "$OUT" == *"would set  claude.cwd: /tmp -> $work"* && "$OUT" == *"unchanged  claude.personas.example"* ]] &&
  cmp -s "$T/before.json" "$T/home/config.json"
check "--check: a claude.cwd that differs is drift (2), and config.json is unchanged"

apply
echo '{"id":"stranger","matches":["https://example.com/*"],"js":"x"}' > "$T/state/stranger.json"
apply --check
rc=$?
((rc == 0)) && [[ "$OUT" == *"extra      mods.stranger is registered"* && "$OUT" != *would* ]]
check "--check: an extra mod is not drift (0)"

write_check_config "Plain." "enabled: false"
apply --check
rc=$?
((rc == 2)) && [[ "$OUT" == *"would remove mods.plain (disabled)"* && -e "$T/state/plain.json" ]]
check "--check: a registered mod turned off is drift (2), and stays registered"

write_check_config "Changed."
cat >> "$T/chrome.yaml" << 'EOF2'
  broken:
    matches: ["https://example.com/*"]
    file: missing.js
EOF2
apply --check
rc=$?
((rc == 1)) && [[ "$OUT" == *"mods.broken: cannot read file"* && "$OUT" == *"would set  claude.personas.example"* ]]
check "--check: an error (a missing mod file) wins over drift (1)"

# The user config --------------------------------------------------------------
# Without a path the script applies the chrome.yaml of its own repository and
# then the user config, so these runs use a copy of the script in $T/repo, with
# HOME at $T (paths print as ~/...) and the user config in $T/xdg.
mkdir -p "$T/repo/scripts" "$T/repo/mods" "$T/xdg/chromefile/mods" "$T/empty"
cp "$REPO/scripts/chrome-apply.sh" "$T/repo/scripts/"
echo 'console.log("repo");' > "$T/repo/mods/repo-mod.js"
echo 'console.log("user");' > "$T/xdg/chromefile/mods/user-mod.js"
write_repo_config() {
  cat > "$T/repo/chrome.yaml" << 'EOF2'
mods:
  repo-mod:
    matches: ["https://example.com/*"]
    file: mods/repo-mod.js
EOF2
}
write_repo_config
write_user_config() {
  cat > "$T/xdg/chromefile/chrome.yaml" << 'EOF2'
claude:
  personas:
    mine: My own voice. voice-marker
mods:
  user-mod:
    matches: ["https://example.com/*"]
    file: mods/user-mod.js
EOF2
}
write_user_config

# apply_auto [OPTION...]: runs the copy from $T with HOME at $AUTO_HOME
# (default $T) and XDG_CONFIG_HOME at $XDG (default $T/xdg), output in OUT.
apply_auto() {
  local rc=0
  OUT="$(cd "$T" && PATH="$T/bin:$PATH" HOME="${AUTO_HOME:-$T}" XDG_CONFIG_HOME="${XDG:-$T/xdg}" STATE="$T/state" \
    CHROMEFILE_CMD="$T/bin/chromefile" CHROMEFILE_HOME="$T/home" "$T/repo/scripts/chrome-apply.sh" "$@" 2>&1)" || rc=$?
  return "$rc"
}

# A registered mod that neither file declares.
rm -f "$T"/state/*.json
echo '{"id":"stranger","matches":["https://example.com/*"],"js":"x"}' > "$T/state/stranger.json"
apply_auto --dry-run
rc=$?
((rc == 0)) && [[ "$OUT" == *"would set  mods.repo-mod: not registered"*"applying   ~/xdg/chromefile/chrome.yaml"*"would set  mods.user-mod: not registered"* ]] &&
  [[ ! -e "$T/state/repo-mod.json" && ! -e "$T/state/user-mod.json" ]]
check "dry run without a path covers both files and registers nothing"

apply_auto
rc=$?
((rc == 0)) && [[ "$OUT" == *"changed    mods.repo-mod: registered"*"applying   ~/xdg/chromefile/chrome.yaml"*"changed    mods.user-mod: registered"* ]] &&
  [[ "$OUT" == *"changed    claude.personas.mine"* && "$OUT" != *voice-marker* ]] &&
  [[ "$(yq -p=json -o=json -r '.js' "$T/state/user-mod.json")" == 'console.log("user");' ]]
check "without a path applies the repo file, then the user config"
[[ "$OUT" != *"extra      mods.repo-mod"* && "$OUT" != *"extra      mods.user-mod"* && "$(grep -c mods.stranger <<< "$OUT")" == 1 ]] &&
  [[ "$OUT" == *"extra      mods.stranger is registered but not in ~/xdg/chromefile/chrome.yaml or ~/repo/chrome.yaml (left alone)"* ]]
check "reports only a mod in neither file as extra, once"

echo 'console.log("user, edited");' > "$T/xdg/chromefile/mods/user-mod.js"
apply_auto "$T/repo/chrome.yaml"
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  mods.repo-mod"* && "$OUT" != *applying* && "$OUT" != *claude.personas* ]] &&
  [[ "$OUT" == *"extra      mods.user-mod is registered but not in ~/repo/chrome.yaml (left alone)"* ]] &&
  [[ "$(yq -p=json -o=json -r '.js' "$T/state/user-mod.json")" == 'console.log("user");' ]]
check "a path applies only that file and reports the user mod as extra"

XDG="$T/empty" apply_auto "$T/repo/chrome.yaml"
explicit="$OUT"
XDG="$T/empty" apply_auto
rc=$?
((rc == 0)) && [[ "$OUT" == "$explicit" && "$OUT" != *applying* ]]
check "without a user config, the same output as with the repo file's path"

# Relative to the working directory ($T), xdg/chromefile/chrome.yaml exists, so
# using it would apply user-mod.
mkdir -p "$T/fakehome/.config/chromefile/mods"
echo 'console.log("home");' > "$T/fakehome/.config/chromefile/mods/home-mod.js"
cat > "$T/fakehome/.config/chromefile/chrome.yaml" << 'EOF2'
mods:
  home-mod:
    matches: ["https://example.com/*"]
    file: mods/home-mod.js
EOF2
AUTO_HOME="$T/fakehome" XDG=xdg apply_auto
rc=$?
((rc == 0)) && [[ "$OUT" == *"applying   ~/.config/chromefile/chrome.yaml"* && "$OUT" == *"changed    mods.home-mod: registered"* ]] &&
  [[ "$OUT" != *"mods.user-mod: "* && "$OUT" != *"unchanged  mods.user-mod"* ]]
check "ignores a relative XDG_CONFIG_HOME"

cat >> "$T/repo/chrome.yaml" << 'EOF2'
  broken:
    matches: ["https://example.com/*"]
    file: mods/missing.js
EOF2
apply_auto
rc=$?
((rc == 1)) && [[ "$OUT" == *"mods.broken: cannot read file"*"1 error(s); the rest was applied"*"applying   "*"changed    mods.user-mod: updated (code)"* ]]
check "an error in the repo file still applies the user config, exit status 1"

echo '- not a mapping' > "$T/repo/chrome.yaml"
echo 'console.log("user, again");' > "$T/xdg/chromefile/mods/user-mod.js"
apply_auto
rc=$?
((rc == 1)) && [[ "$OUT" == *"is not a YAML mapping"*"applying   "*"changed    mods.user-mod: updated (code)"* ]]
check "a repo file that stops its run still applies the user config"

write_repo_config
cat >> "$T/xdg/chromefile/chrome.yaml" << 'EOF2'
  user-broken:
    matches: ["https://example.com/*"]
    file: mods/missing.js
EOF2
apply_auto
rc=$?
((rc == 1)) && [[ "$OUT" == *"unchanged  mods.repo-mod"*"applying   "*"mods.user-broken: cannot read file"* ]]
check "an error in the user config gives exit status 1"

rm -f "$T"/state/*.json
write_repo_config
write_user_config
apply_auto
apply_auto --check
rc=$?
((rc == 0)) && [[ "$OUT" == *"unchanged  mods.repo-mod"*"applying   "*"unchanged  mods.user-mod"* && "$OUT" != *would* ]]
check "--check without a path: both files in sync is 0"

echo 'console.log("user, drifted");' > "$T/xdg/chromefile/mods/user-mod.js"
apply_auto --check
rc=$?
((rc == 2)) && [[ "$OUT" == *"unchanged  mods.repo-mod"*"applying   "*"would set  mods.user-mod: differs in code"* ]] &&
  [[ "$(yq -p=json -o=json -r '.js' "$T/state/user-mod.json")" != *drifted* ]]
check "--check without a path: drift only in the user config is 2"

cat >> "$T/repo/chrome.yaml" << 'EOF2'
  broken:
    matches: ["https://example.com/*"]
    file: mods/missing.js
EOF2
apply_auto --check
rc=$?
((rc == 1)) && [[ "$OUT" == *"mods.broken: cannot read file"*"applying   "*"would set  mods.user-mod: differs in code"* ]]
check "--check without a path: an error in one file and drift in the other is 1"

[[ ! -e "$T/osascript-called" ]]
check "never runs osascript (user config)"

# Shortcut strings -------------------------------------------------------------
# chrome_keybinding needs no Chrome, so it is taken out of the script and run
# here, with norm_key, which reads the shortcut back. What Chrome makes of the
# string sent (updateExtensionCommand on macOS: Command is ⌘, Ctrl is ⌃, and
# MacCtrl is nothing) must be what norm_key reads in the YAML value, or the
# read back fails.
eval "$(sed -n -e '/^norm_key() {/,/^}/p' -e '/^chrome_keybinding() {/,/^}/p' "$REPO/scripts/chrome-apply.sh")"

# chrome_shows SENT: the symbols Chrome shows for SENT. A token it does not
# know stays as text, so it can't match.
chrome_shows() {
  local out="" part
  local -a parts
  [[ -n "$1" ]] || return 0
  IFS=+ read -ra parts <<< "$1"
  for part in "${parts[@]}"; do
    case "$part" in
      Command) out+="⌘" ;;
      Ctrl) out+="⌃" ;;
      Alt) out+="⌥" ;;
      Shift) out+="⇧" ;;
      *) out+="$part" ;;
    esac
  done
  printf '%s' "$out"
}

OUT=""
while IFS='|' read -r yaml sent; do
  got="$(chrome_keybinding "$yaml")"
  shown="$(chrome_shows "$got")"
  if [[ "$got" != "$sent" || "$(norm_key "$shown")" != "$(norm_key "$yaml")" ]]; then
    OUT+="$yaml: sent \"$got\" (want \"$sent\"), Chrome shows \"$shown\""$'\n'
  fi
done << 'EOF2'
Command+J|Command+J
Cmd+J|Command+J
command+J|Command+J
Ctrl+Shift+K|Command+Shift+K
MacCtrl+L|Ctrl+L
macctrl+shift+L|Ctrl+Shift+L
Alt+Shift+K|Alt+Shift+K
Option+K|Alt+K
Shift+Command+Comma|Shift+Command+Comma
|
EOF2
[[ -z "$OUT" ]]
check "sends Ctrl and Command as Command and MacCtrl as Ctrl, as norm_key reads them"

if ((failures)); then
  echo "$failures failure(s)"
  exit 1
fi
echo "all passed"
