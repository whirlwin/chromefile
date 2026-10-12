#!/usr/bin/env bash
# Applies chrome.yaml to the running Google Chrome, for the profile of its
# front window: Chrome preferences, extension keyboard shortcuts, the Claude
# session settings and mods (user scripts). Idempotent: only values that differ
# are changed.
#
# How (settings, shortcuts): Chrome's AppleScript `execute javascript` runs
# code in a tab. The private APIs behind chrome://settings
# (chrome.settingsPrivate) and chrome://extensions/shortcuts
# (chrome.developerPrivate) are only exposed on those pages, so we open them as
# background tabs, drive them, and close them. It needs "Allow JavaScript from
# Apple Events" (View > Developer) in Chrome.
#
# claude.cwd is written to the bridge's config.json (in the app directory,
# see scripts/lib.sh), where the host reads it when it spawns a Claude session.
#
# Mods go through the bridge: `cbb call mods.*` (override the command with
# CBB_CMD=/path/to/executable, for tests). Each mod's `file` is relative to the
# directory of the config file. Mods registered in Chrome but missing from the
# config are reported and left alone, never removed. If the bridge is not
# connected the mods are reported as an error and the rest is still applied.
#
# Usage:
#   scripts/chrome-apply.sh [--dry-run] [path/to/chrome.yaml]
#   scripts/chrome-apply.sh --list-settings [regex]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"
}

die() {
  echo "error: $*" >&2
  exit 1
}

mode=apply
dry_run=false
config=""
filter=""
while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --list-settings)
      mode=list
      if (($# > 1)) && [[ "$2" != --* ]]; then
        filter="$2"
        shift
      fi
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [[ -z "$config" ]] || die "only one config path may be given"
      config="$1"
      ;;
  esac
  shift
done
config="${config:-$REPO/chrome.yaml}"

[[ "$(uname -s)" == Darwin ]] || die "macOS only"
# shellcheck source=scripts/lib.sh
source "$REPO/scripts/lib.sh" # APP_DIR
command -v yq > /dev/null || die "yq not found; run 'mise install' in $REPO"
if [[ "$mode" == apply ]]; then
  [[ -r "$config" ]] || die "cannot read $config"
  yq -e 'type == "!!map"' "$config" > /dev/null 2>&1 || die "$config is not a YAML mapping"
fi

# Don't launch Chrome: `is running` checks without starting it.
running="$(osascript -e 'application "Google Chrome" is running')"
[[ "$running" == true ]] || die "Google Chrome is not running; start it first"
windows="$(osascript -e 'tell application "Google Chrome" to count windows')"
((windows > 0)) || die "Google Chrome has no open window; open one first"

# Helper tabs we opened, as "windowId:tabId". Only these are ever closed.
HELPER_TABS=()

cleanup() {
  local t
  for t in "${HELPER_TABS[@]+"${HELPER_TABS[@]}"}"; do
    osascript - "${t%%:*}" "${t##*:}" > /dev/null 2>&1 << 'EOF' || true
on run argv
  tell application "Google Chrome"
    close my findTab(item 1 of argv, item 2 of argv)
  end tell
end run
-- Window and tab ids can exceed the AppleScript integer range (2^29), where
-- `as integer` turns them into reals that match nothing, so compare them as text.
on findTab(wid, tid)
  tell application "Google Chrome"
    repeat with w in windows
      if (id of w as text) is wid then
        repeat with t in tabs of w
          if (id of t as text) is tid then return contents of t
        end repeat
      end if
    end repeat
  end tell
  error "tab " & tid & " not found"
end findTab
EOF
  done
}
trap cleanup EXIT

# open_tab URL: opens URL as a background tab in the front window, waits for
# it to load, and sets TAB to "windowId:tabId". Not run in a subshell, so the
# tab is recorded for cleanup.
open_tab() {
  local ref i
  ref="$(osascript - "$1" << 'EOF'
on run argv
  tell application "Google Chrome"
    set w to front window
    set prev to active tab index of w
    set t to make new tab at end of tabs of w with properties {URL:(item 1 of argv)}
    set active tab index of w to prev
    return (id of w as text) & ":" & (id of t as text)
  end tell
end run
EOF
  )"
  HELPER_TABS+=("$ref")
  for ((i = 0; i < 100; i++)); do
    if [[ "$(osascript - "${ref%%:*}" "${ref##*:}" << 'EOF'
on run argv
  tell application "Google Chrome"
    return loading of my findTab(item 1 of argv, item 2 of argv)
  end tell
end run
-- Window and tab ids can exceed the AppleScript integer range (2^29), where
-- `as integer` turns them into reals that match nothing, so compare them as text.
on findTab(wid, tid)
  tell application "Google Chrome"
    repeat with w in windows
      if (id of w as text) is wid then
        repeat with t in tabs of w
          if (id of t as text) is tid then return contents of t
        end repeat
      end if
    end repeat
  end tell
  error "tab " & tid & " not found"
end findTab
EOF
    )" == false ]]; then
      TAB="$ref"
      return
    fi
    sleep 0.1
  done
  die "timed out waiting for $1 to load"
}

# exec_js TAB JS: runs JS in the tab and prints its result. The JS travels as
# an osascript argument, so no AppleScript quoting is involved.
exec_js() {
  local out
  if ! out="$(osascript - "${1%%:*}" "${1##*:}" "$2" 2>&1 << 'EOF'
on run argv
  tell application "Google Chrome"
    set t to my findTab(item 1 of argv, item 2 of argv)
    return execute t javascript (item 3 of argv)
  end tell
end run
-- Window and tab ids can exceed the AppleScript integer range (2^29), where
-- `as integer` turns them into reals that match nothing, so compare them as text.
on findTab(wid, tid)
  tell application "Google Chrome"
    repeat with w in windows
      if (id of w as text) is wid then
        repeat with t in tabs of w
          if (id of t as text) is tid then return contents of t
        end repeat
      end if
    end repeat
  end tell
  error "tab " & tid & " not found"
end findTab
EOF
  )"; then
    if [[ "$out" == *"Apple Events"* || "$out" == *"AppleScript"* ]]; then
      die "Chrome refused to run JavaScript. Enable it in Chrome: View > Developer > Allow JavaScript from Apple Events
($out)"
    fi
    die "osascript failed: $out"
  fi
  printf '%s' "$out"
}

# call_api TAB DATA_JSON FN: FN is a JS function (D, done) that calls an async
# Chrome API with the decoded DATA_JSON as D and passes the result to done.
# Prints {"ok": result} or {"error": message} as JSON. The data is base64
# encoded so no value can break out of the JS string.
call_api() {
  local tab="$1" b64 js out i
  b64="$(printf '%s' "$2" | base64 | tr -d '\n')"
  js="(function(){window.__cbb=undefined;try{
var D=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('$b64'),function(c){return c.charCodeAt(0);})));
($3)(D,function(r){var e=window.chrome&&chrome.runtime&&chrome.runtime.lastError;
window.__cbb=JSON.stringify(e?{error:e.message}:{ok:r===undefined?null:r});});
}catch(x){window.__cbb=JSON.stringify({error:String(x)});}return 'started';})()"
  exec_js "$tab" "$js" > /dev/null
  for ((i = 0; i < 100; i++)); do
    out="$(exec_js "$tab" "typeof window.__cbb==='string'?window.__cbb:''")"
    if [[ -n "$out" ]]; then
      printf '%s' "$out"
      return
    fi
    sleep 0.1
  done
  die "timed out waiting for a Chrome API call"
}

# api_ok RESULT: prints the "ok" part, or fails with the "error" part.
api_ok() {
  local err
  [[ -n "$1" ]] || die "no result from Chrome"
  err="$(yq -p=json -o=json -I=0 '.error // ""' <<< "$1")"
  [[ "$err" == '""' ]] || die "Chrome API error: $err"
  yq -p=json -o=json -I=0 '.ok' <<< "$1"
}

# canon JSON: compact JSON with sorted map keys, for comparing values.
canon() {
  yq -p=json -o=json -I=0 'sort_keys(..)' <<< "$1"
}

# norm_key BINDING: canonical form of a shortcut, accepting both the manifest
# format (Command+Shift+J) and Chrome's macOS display form (⇧⌘J). On macOS
# "Ctrl" in a manifest means Command and "MacCtrl" means Control.
norm_key() {
  local s="$1" mods="" key part
  [[ -n "$s" ]] || return 0
  if [[ "$s" == *+* ]]; then
    IFS=+ read -ra parts <<< "$s"
    key="${parts[${#parts[@]} - 1]}"
    for part in "${parts[@]:0:${#parts[@]}-1}"; do
      case "$(tr '[:upper:]' '[:lower:]' <<< "$part")" in
        command | cmd | ctrl) mods+="C" ;;
        macctrl) mods+="T" ;;
        alt | option) mods+="A" ;;
        shift) mods+="S" ;;
        *) mods+="?$part" ;;
      esac
    done
  else
    key="$s"
    while :; do
      case "$key" in
        ⌘*) mods+="C" key="${key#⌘}" ;;
        ⌃*) mods+="T" key="${key#⌃}" ;;
        ⌥*) mods+="A" key="${key#⌥}" ;;
        ⇧*) mods+="S" key="${key#⇧}" ;;
        *) break ;;
      esac
    done
  fi
  case "$key" in
    ,) key=Comma ;;
    .) key=Period ;;
    ↑) key=Up ;;
    ↓) key=Down ;;
    ←) key=Left ;;
    →) key=Right ;;
  esac
  # Fixed modifier order so "Shift+Command" and "Command+Shift" compare equal.
  printf '%s%s%s%s+%s\n' \
    "$([[ $mods == *T* ]] && echo MacCtrl+)" "$([[ $mods == *A* ]] && echo Alt+)" \
    "$([[ $mods == *S* ]] && echo Shift+)" "$([[ $mods == *C* ]] && echo Command)" \
    "$(tr '[:lower:]' '[:upper:]' <<< "$key")"
}

GET_ALL_PREFS='function(D,done){chrome.settingsPrivate.getAllPrefs(function(ps){done(ps.map(function(p){return {key:p.key,value:p.value===undefined?null:p.value};}));});}'
GET_PREF='function(D,done){chrome.settingsPrivate.getPref(D.key,function(p){done(p?(p.value===undefined?null:p.value):null);});}'
SET_PREF='function(D,done){chrome.settingsPrivate.setPref(D.key,D.value,"",done);}'
GET_EXTENSIONS='function(D,done){chrome.developerPrivate.getExtensionsInfo(function(es){done(es.map(function(e){return {id:e.id,name:e.name,commands:(e.commands||[]).map(function(c){return {name:c.name,keybinding:c.keybinding};})};}));});}'
SET_COMMAND='function(D,done){chrome.developerPrivate.updateExtensionCommand({extensionId:D.id,commandName:D.command,keybinding:D.keybinding},function(){done(true);});}'

if [[ "$mode" == list ]]; then
  open_tab chrome://settings
  tab="$TAB"
  prefs="$(api_ok "$(call_api "$tab" '{}' "$GET_ALL_PREFS")")"
  yq -p=json -r '.[] | .key + " = " + (.value | to_json(0))' <<< "$prefs" \
    | LC_ALL=C sort | { grep -E -- "${filter:-.}" || true; }
  exit 0
fi

failures=0
fail() {
  echo "error: $*" >&2
  failures=$((failures + 1))
}
verb="changed   "
$dry_run && verb="would set "

# Settings ------------------------------------------------------------------
if [[ "$(yq '.settings | length' "$config")" != 0 ]]; then
  open_tab chrome://settings
  tab="$TAB"
  prefs="$(api_ok "$(call_api "$tab" '{}' "$GET_ALL_PREFS")")"
  while IFS= read -r key; do
    data="$(KEY="$key" yq -o=json -I=0 '{"key": strenv(KEY), "value": .settings[strenv(KEY)]}' "$config")"
    want="$(canon "$(yq -p=json -o=json -I=0 '.value' <<< "$data")")"
    if [[ "$(KEY="$key" yq -p=json '[.[] | select(.key == strenv(KEY))] | length' <<< "$prefs")" == 0 ]]; then
      fail "unknown setting settings.$key (list them with --list-settings)"
      continue
    fi
    have="$(canon "$(KEY="$key" yq -p=json -o=json -I=0 '.[] | select(.key == strenv(KEY)) | .value' <<< "$prefs")")"
    if [[ "$have" == "$want" ]]; then
      echo "unchanged  settings.$key = $have"
      continue
    fi
    if $dry_run; then
      echo "$verb settings.$key: $have -> $want"
      continue
    fi
    ok="$(api_ok "$(call_api "$tab" "$data" "$SET_PREF")")"
    now="$(canon "$(api_ok "$(call_api "$tab" "$data" "$GET_PREF")")")"
    if [[ "$ok" != true || "$now" != "$want" ]]; then
      fail "could not set settings.$key to $want (Chrome reports $now; policy-managed or wrong type?)"
      continue
    fi
    echo "$verb settings.$key: $have -> $now"
  done < <(yq -r '.settings // {} | keys | .[]' "$config")
fi

# Shortcuts -----------------------------------------------------------------
if [[ "$(yq '.shortcuts | length' "$config")" != 0 ]]; then
  open_tab chrome://extensions/shortcuts
  tab="$TAB"
  exts="$(api_ok "$(call_api "$tab" '{}' "$GET_EXTENSIONS")")"
  while IFS= read -r ext; do
    matches="$(EXT="$ext" yq -p=json -o=json -I=0 '[.[] | select(.name == strenv(EXT))]' <<< "$exts")"
    count="$(yq -p=json 'length' <<< "$matches")"
    if [[ "$count" == 0 ]]; then
      fail "no installed extension is named \"$ext\""
      continue
    elif [[ "$count" != 1 ]]; then
      fail "$count installed extensions are named \"$ext\": $(yq -p=json -r '[.[].id] | join(", ")' <<< "$matches")"
      continue
    fi
    id="$(yq -p=json -r '.[0].id' <<< "$matches")"
    while IFS= read -r cmd; do
      label="shortcuts.\"$ext\".$cmd"
      want_raw="$(EXT="$ext" CMD="$cmd" yq -r '.shortcuts[strenv(EXT)][strenv(CMD)] // ""' "$config")"
      if [[ -z "$(CMD="$cmd" yq -p=json '.[0].commands[] | select(.name == strenv(CMD)) | .name' <<< "$matches")" ]]; then
        fail "$ext has no command \"$cmd\"; it has: $(yq -p=json -r '[.[0].commands[].name] | join(", ")' <<< "$matches")"
        continue
      fi
      have_raw="$(ID="$id" CMD="$cmd" yq -p=json -r '.[] | select(.id == strenv(ID)) | .commands[] | select(.name == strenv(CMD)) | .keybinding' <<< "$exts")"
      want="$(norm_key "$want_raw")"
      have="$(norm_key "$have_raw")"
      if [[ "$want" == "$have" ]]; then
        echo "unchanged  $label = ${want:-(none)}"
        continue
      fi
      if $dry_run; then
        echo "$verb $label: ${have:-(none)} -> ${want:-(none)}"
        continue
      fi
      data="$(ID="$id" CMD="$cmd" KB="$want_raw" yq -n -o=json -I=0 '{"id": strenv(ID), "command": strenv(CMD), "keybinding": strenv(KB)}')"
      api_ok "$(call_api "$tab" "$data" "$SET_COMMAND")" > /dev/null
      exts="$(api_ok "$(call_api "$tab" '{}' "$GET_EXTENSIONS")")"
      now="$(norm_key "$(ID="$id" CMD="$cmd" yq -p=json -r '.[] | select(.id == strenv(ID)) | .commands[] | select(.name == strenv(CMD)) | .keybinding' <<< "$exts")")"
      if [[ "$now" != "$want" ]]; then
        fail "could not set $label to ${want:-(none)} (Chrome reports ${now:-(none)})"
        continue
      fi
      echo "$verb $label: ${have:-(none)} -> ${now:-(none)}"
    done < <(EXT="$ext" yq -r '.shortcuts[strenv(EXT)] | keys | .[]' "$config")
  done < <(yq -r '.shortcuts // {} | keys | .[]' "$config")
fi

# Claude ----------------------------------------------------------------------
# Settings for Claude Code sessions the bridge spawns, kept in config.json in
# the app directory. Other keys in that file are preserved.
CLAUDE_CONFIG="$APP_DIR/config.json"
want_cwd="$(yq -r '.claude.cwd // ""' "$config")"
if [[ -n "$want_cwd" ]]; then
  # Expand a leading ~ only; anything else must already be absolute.
  case "$want_cwd" in
    \~ | \~/*) want_cwd="$HOME${want_cwd:1}" ;;
  esac
  if [[ "$want_cwd" != /* ]]; then
    fail "claude.cwd must be an absolute path or start with ~ (got $want_cwd)"
  elif [[ ! -d "$want_cwd" ]]; then
    fail "claude.cwd: directory $want_cwd does not exist"
  else
    want_cwd="$(cd "$want_cwd" && pwd)"
    have_cwd=""
    if [[ -s "$CLAUDE_CONFIG" ]]; then
      if ! have_cwd="$(yq -p=json -r '.claude.cwd // ""' "$CLAUDE_CONFIG" 2> /dev/null)"; then
        fail "$CLAUDE_CONFIG is not valid JSON; fix or remove it"
        want_cwd=""
      fi
    fi
    if [[ -z "$want_cwd" ]]; then
      :
    elif [[ "$have_cwd" == "$want_cwd" ]]; then
      echo "unchanged  claude.cwd = $want_cwd"
    elif $dry_run; then
      echo "$verb claude.cwd: ${have_cwd:-(none)} -> $want_cwd"
    else
      mkdir -p "$APP_DIR"
      chmod 700 "$APP_DIR"
      tmp="$(umask 077 && mktemp "$APP_DIR/config.json.XXXXXX")"
      if [[ -s "$CLAUDE_CONFIG" ]]; then
        CWD="$want_cwd" yq -p=json -o=json '.claude.cwd = strenv(CWD)' "$CLAUDE_CONFIG" > "$tmp"
      else
        CWD="$want_cwd" yq -n -o=json '.claude.cwd = strenv(CWD)' > "$tmp"
      fi
      chmod 600 "$tmp"
      mv -f "$tmp" "$CLAUDE_CONFIG"
      echo "$verb claude.cwd: ${have_cwd:-(none)} -> $want_cwd"
    fi
  fi
fi

# Mods ------------------------------------------------------------------------
# cbb_call METHOD JSON: runs `cbb call` and sets CBB_OUT (stdout) and CBB_ERR
# (first stderr line). Returns cbb's exit status: 0 ok, 2 not connected, other
# non-zero for an error. Never exits the script.
if [[ -n "${CBB_CMD:-}" ]]; then
  CBB=("$CBB_CMD")
else
  CBB=(node "$REPO/host/dist/cbb.js")
fi
cbb_call() {
  local errfile rc=0
  errfile="$(mktemp)"
  CBB_OUT="$("${CBB[@]}" call "$1" "$2" 2> "$errfile")" || rc=$?
  CBB_ERR="$(head -n 1 "$errfile")"
  rm -f "$errfile"
  return "$rc"
}

# mod_state JSON: the comparable fields of a registered or wanted mod, with
# Chrome's defaults filled in, as canonical JSON.
mod_state() {
  yq -p=json -o=json -I=0 '{
    "matches": (.matches // []),
    "js": (.js | select(tag == "!!str") // ([.[]? | .code // ""] | join(""))),
    "runAt": (.runAt // "document_idle"),
    "world": (.world // "USER_SCRIPT")
  } | sort_keys(.)' <<< "$1"
}

# mod_diff HAVE WANT: names of the fields that differ, comma separated.
mod_diff() {
  local f out=()
  for f in matches js runAt world; do
    [[ "$(F="$f" yq -p=json -o=json -I=0 '.[strenv(F)]' <<< "$1")" == \
      "$(F="$f" yq -p=json -o=json -I=0 '.[strenv(F)]' <<< "$2")" ]] || out+=("${f/js/code}")
  done
  local IFS=,
  printf '%s' "${out[*]}"
}

if [[ "$(yq '.mods | length' "$config")" != 0 ]]; then
  config_dir="$(cd "$(dirname "$config")" && pwd)"
  if cbb_call mods.list '{}'; then
    registered="$(yq -p=json -o=json -I=0 '.mods // []' <<< "$CBB_OUT")"
  else
    rc=$?
    if ((rc == 2)); then
      fail "mods not applied: the bridge is not connected (is Chrome running with the extension on?)${CBB_ERR:+ ($CBB_ERR)}"
    else
      fail "mods not applied: ${CBB_ERR:-cbb call mods.list failed with status $rc}"
    fi
    registered=""
  fi
  if [[ -n "$registered" ]]; then
    while IFS= read -r id; do
      label="mods.$id"
      file="$(ID="$id" yq -r '.mods[strenv(ID)].file // ""' "$config")"
      [[ -z "$file" || "$file" == /* ]] || file="$config_dir/$file"
      if [[ -z "$file" || ! -r "$file" ]]; then
        fail "$label: cannot read file ${file:-(none given)}"
        continue
      fi
      if [[ "$(ID="$id" yq '.mods[strenv(ID)].matches | (tag == "!!seq" and length > 0)' "$config")" != true ]]; then
        fail "$label: matches must be a non-empty list of URL patterns"
        continue
      fi
      data="$(ID="$id" F="$file" yq -o=json -I=0 '.mods[strenv(ID)] | {
        "id": strenv(ID),
        "matches": .matches,
        "js": load_str(strenv(F)),
        "runAt": (.runAt // "document_idle"),
        "world": (.world // "USER_SCRIPT")
      }' "$config")"
      want="$(mod_state "$data")"
      have_raw="$(ID="$id" yq -p=json -o=json -I=0 '[.[] | select(.id == strenv(ID))] | .[0] // null' <<< "$registered")"
      if [[ "$have_raw" == null ]]; then
        what="not registered"
        done_what="registered"
      else
        have="$(mod_state "$have_raw")"
        if [[ "$have" == "$want" ]]; then
          echo "unchanged  $label"
          continue
        fi
        diff="$(mod_diff "$have" "$want")"
        what="differs in $diff"
        done_what="updated ($diff)"
      fi
      if $dry_run; then
        echo "$verb $label: $what"
        continue
      fi
      if ! cbb_call mods.register "$data"; then
        fail "could not register $label: ${CBB_ERR:-cbb call mods.register failed}"
        continue
      fi
      # Read back, like the settings: the bridge must now report what we want.
      if ! cbb_call mods.list '{}'; then
        fail "could not read back $label: ${CBB_ERR:-cbb call mods.list failed}"
        continue
      fi
      registered="$(yq -p=json -o=json -I=0 '.mods // []' <<< "$CBB_OUT")"
      now_raw="$(ID="$id" yq -p=json -o=json -I=0 '[.[] | select(.id == strenv(ID))] | .[0] // null' <<< "$registered")"
      if [[ "$now_raw" == null || "$(mod_state "$now_raw")" != "$want" ]]; then
        fail "registered $label but the bridge reports something else"
        continue
      fi
      echo "$verb $label: $done_what"
    done < <(yq -r '.mods // {} | keys | .[]' "$config")
    while IFS= read -r id; do
      [[ -n "$id" ]] || continue
      if [[ "$(ID="$id" yq '.mods | has(strenv(ID))' "$config")" != true ]]; then
        echo "extra      mods.$id is registered but not in chrome.yaml (left alone)"
      fi
    done < <(yq -p=json -r '.[].id' <<< "$registered")
  fi
fi

if ((failures)); then
  if $dry_run; then
    echo "$failures error(s)" >&2
  else
    echo "$failures error(s); the rest was applied" >&2
  fi
  exit 1
fi
