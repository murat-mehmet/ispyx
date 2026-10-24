#!/bin/sh
# ispyx installer and updater for macOS: puts the newest Ispyx.app from the GitHub releases in /Applications.
#
#   curl -fsSL https://github.com/murat-mehmet/ispyx/releases/latest/download/install.sh | sh
#
# With options:   curl -fsSL .../install.sh | sh -s -- --uninstall
#
#   --uninstall   quit Ispyx and remove the app (keeps settings and logs)
#   --purge       with --uninstall: also delete ~/Library/Application Support/Ispyx and reset its permissions
#   --force       install even when this version is already there
#   --no-open     do not open Ispyx at the end
#   --dmg PATH    install from a local Ispyx-<version>.dmg instead of downloading (tests before a release)
#   --dry-run     only print what would be done, change nothing
#
# ISPYX_APP_DIR=<folder> installs there instead (tests); an existing install elsewhere is then ignored.
#
# Running it again updates: it does nothing when the newest version is installed. The app is checked before it
# replaces anything: SHA-256 from the release, a valid Developer ID signature of team 4U354YMA8D, notarised.
# macOS keeps the permissions across updates (they belong to the bundle id and the team, not to the file).
set -eu

REPO="murat-mehmet/ispyx"
TEAM_ID="4U354YMA8D"
BUNDLE_ID="com.ispyx.app"
DATA_DIR="$HOME/Library/Application Support/Ispyx"

UNINSTALL=0 PURGE=0 FORCE=0 OPEN=1 DRY=0 LOCAL_DMG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --force) FORCE=1 ;;
    --no-open) OPEN=0 ;;
    --dry-run) DRY=1 ;;
    --dmg) shift; LOCAL_DMG="${1:-}" ;;
    *) echo "ispyx: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'ispyx: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then say "    [dry-run] would: $*"; else "$@"; fi; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS. On Windows use install.ps1 (see the README)."

# where an installed Ispyx.app is: /Applications or ~/Applications, also in a subfolder there (Spotlight finds
# those). Copies anywhere else (a build folder, a mounted disk image) are not installs and are left alone.
installed_app() {
  if [ -n "${ISPYX_APP_DIR:-}" ]; then [ -d "$ISPYX_APP_DIR/Ispyx.app" ] && printf '%s\n' "$ISPYX_APP_DIR/Ispyx.app"; return 0; fi
  for p in "/Applications/Ispyx.app" "$HOME/Applications/Ispyx.app"; do
    [ -d "$p" ] && { printf '%s\n' "$p"; return; }
  done
  mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" 2>/dev/null | grep -E "^(/Applications|$HOME/Applications)/.*\.app$" | head -1 || true
}
app_version() { /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null || true; }
# the app bundle of the running Ispyx, if any (from its executable's path)
running_app() { ps -axo args= | awk '$1 ~ /\/Ispyx\.app\/Contents\/MacOS\/Ispyx$/ { sub(/\/Contents\/MacOS\/Ispyx$/, "", $1); print $1; exit }'; }

# Quits the Ispyx that runs from $1 (which also ends its resident server and every AI app's ispyx connection).
# Another copy that runs elsewhere (a build folder) is left alone.
quit_app() {
  r="$(running_app)"
  [ -n "$r" ] || return 0
  if [ "$r" != "$1" ]; then say "    Another Ispyx runs from $r; leaving it running."; return 0; fi
  say "    Quitting Ispyx"
  [ "$DRY" = 1 ] && return 0
  osascript -e "quit app id \"$BUNDLE_ID\"" >/dev/null 2>&1 || true
  i=0
  while [ -n "$(running_app)" ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  [ -z "$(running_app)" ] || fail "Ispyx did not quit. Quit it from the menu bar and run this again."
  return 0
}

# ---- uninstall ------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  step "Removing Ispyx"
  APP="$(installed_app)"
  [ -n "$APP" ] && quit_app "$APP"
  if [ -n "$APP" ]; then
    if [ -w "$(dirname "$APP")" ]; then run rm -rf "$APP"; else run sudo rm -rf "$APP"; fi
    say "    Removed $APP"
  else
    say "    Ispyx.app is not installed."
  fi
  if [ "$PURGE" = 1 ]; then
    run rm -rf "$DATA_DIR"
    run tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
    run tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null 2>&1 || true
    say "    Deleted settings and logs, reset the permissions."
  fi
  say ""
  say "Remove the ispyx entry from your AI apps too, e.g. claude mcp remove ispyx --scope user"
  exit 0
fi

# ---- which version ------------------------------------------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ispyx-install.XXXXXX")"
MNT=""
cleanup() {
  [ -n "$MNT" ] && hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

APP="$(installed_app)"
CURRENT=""
[ -n "$APP" ] && CURRENT="$(app_version "$APP")"

if [ -n "$LOCAL_DMG" ]; then
  [ -f "$LOCAL_DMG" ] || fail "no such file: $LOCAL_DMG"
  DMG="$LOCAL_DMG"
  LATEST=""
else
  step "Looking for the newest version"
  # the latest-release page redirects to .../releases/tag/v<version>; no API call (no rate limit)
  TAG="$(curl -fsSI "https://github.com/$REPO/releases/latest" | tr -d '\r' | sed -n 's|^[Ll]ocation: .*/releases/tag/\(v[^/]*\)$|\1|p' | tail -1)"
  [ -n "$TAG" ] || fail "could not find the latest release of $REPO (offline?)."
  LATEST="${TAG#v}"
  say "    Newest: $LATEST${CURRENT:+, installed: $CURRENT}"
  if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" = 0 ]; then
    say "    Ispyx $CURRENT is up to date."
    if [ "$OPEN" = 1 ] && [ -z "$(running_app)" ]; then run open "$APP"; fi
    exit 0
  fi
  step "Downloading Ispyx $LATEST"
  BASE="https://github.com/$REPO/releases/download/$TAG"
  DMG="$TMP/Ispyx-$LATEST.dmg"
  run curl -fL --progress-bar -o "$DMG" "$BASE/Ispyx-$LATEST.dmg"
  run curl -fsSL -o "$TMP/sum" "$BASE/Ispyx-$LATEST.dmg.sha256"
  if [ "$DRY" = 0 ]; then
    want="$(awk '{print $1}' "$TMP/sum")"
    got="$(shasum -a 256 "$DMG" | awk '{print $1}')"
    [ -n "$want" ] && [ "$want" = "$got" ] || fail "the download does not match its SHA-256 (got $got). Nothing was changed."
    say "    SHA-256 ok"
  fi
fi

# ---- check the app inside -------------------------------------------------------------------------------------
step "Checking the app"
if [ "$DRY" = 1 ]; then
  say "    [dry-run] would mount the disk image and check the signature (team $TEAM_ID), notarisation and version"
else
  MNT="$TMP/mnt"
  mkdir -p "$MNT"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" -quiet || fail "could not open the disk image."
  NEW="$MNT/Ispyx.app"
  [ -d "$NEW" ] || fail "the disk image holds no Ispyx.app."
  codesign --verify --deep --strict "$NEW" 2>/dev/null || fail "the app's signature is not valid. Nothing was changed."
  codesign --verify -R="identifier \"$BUNDLE_ID\" and anchor apple generic and certificate leaf[subject.OU] = \"$TEAM_ID\"" "$NEW" 2>/dev/null \
    || fail "the app is not signed by the ispyx developer (team $TEAM_ID). Nothing was changed."
  spctl --assess --type execute "$NEW" 2>/dev/null || fail "macOS does not accept the app (not notarised). Nothing was changed."
  NEWVER="$(app_version "$NEW")"
  say "    Signed by team $TEAM_ID, notarised, version $NEWVER"
fi

# ---- install --------------------------------------------------------------------------------------------------
# Same place as the installed copy; a new install goes to /Applications, or ~/Applications when that is not writable.
if [ -n "$APP" ]; then DEST="$APP"
elif [ -n "${ISPYX_APP_DIR:-}" ]; then DEST="$ISPYX_APP_DIR/Ispyx.app"
elif [ -w /Applications ]; then DEST="/Applications/Ispyx.app"
else DEST="$HOME/Applications/Ispyx.app"
fi
DIR="$(dirname "$DEST")"
SUDO=""
if [ -d "$DIR" ] && [ ! -w "$DIR" ]; then SUDO="sudo"; say "    $DIR needs your password."; fi

step "Installing to $DEST"
quit_app "$DEST"
run $SUDO mkdir -p "$DIR"
# copy next to it first, then swap: a failed copy leaves the old app untouched
run $SUDO rm -rf "$DEST.new"
run $SUDO ditto "${NEW:-$MNT/Ispyx.app}" "$DEST.new"
run $SUDO rm -rf "$DEST"
run $SUDO mv "$DEST.new" "$DEST"
say "    Installed Ispyx ${NEWVER:-$LATEST}"

if [ "$OPEN" = 1 ]; then
  step "Opening Ispyx"
  # it asks for Accessibility and Screen Recording on the first run; updates keep them
  run open "$DEST"
fi

say ""
if [ -z "$CURRENT" ]; then
  say "Connect your AI app, e.g. Claude Code:"
  say "  claude mcp add ispyx --scope user -- \"$DEST/Contents/Resources/ispyx\""
  say "The Ispyx window shows this and the Claude Desktop entry with Copy buttons."
else
  say "Updated from $CURRENT. AI apps reconnect on their next ispyx call (Claude Code: /mcp)."
fi
